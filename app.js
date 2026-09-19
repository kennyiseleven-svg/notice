import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CONFIG = {
  url: "https://ovvrphgoldrbmwwdbsnw.supabase.co",
  key: "sb_publishable_p5whXiF0KkZothRybnuahQ_olJp5eG7", // 公开的客户端钥匙，权限由数据库 RLS 控制
  emailDomain: "notice.invalid",                          // 必须与 Edge Function 的 EMAIL_DOMAIN 一致
  bucket: "attachments",
  maxImages: 9,
};

const sb = createClient(CONFIG.url, CONFIG.key);
const $app = document.getElementById("app");
const $modal = document.getElementById("modal-root");

const ROLE = { super_admin: "主管理员", admin: "管理员", staff: "员工" };
const STATUS = { live: "生效中", scheduled: "预约中", expired: "已到期", archived: "已归档" };
const ACTION = {
  create_user: "建立帐号", reset_password: "重置密码", deactivate_user: "停用帐号", activate_user: "启用帐号",
  set_role: "变更角色", update_user: "修改员工资料", create_announcement: "发布公告",
  update_announcement: "修改公告", archive_announcement: "归档公告",
};

const S = {
  ready: false, profile: null, departments: [], anns: null, users: null, logs: null,
  view: { name: "list" }, filter: "live", search: "", userSearch: "",
  busy: false, error: "", info: "", popupShown: false, draft: null,
};

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isAdmin = () => ["admin", "super_admin"].includes(S.profile?.role);
const isSuper = () => S.profile?.role === "super_admin";
const deptName = (id) => S.departments.find((d) => d.id === id)?.name ?? "未分配";

function fmt(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date(), p = (n) => String(n).padStart(2, "0");
  const md = `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}
function toLocalInput(date) {
  const d = new Date(date), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function statusOf(a) {
  if (a.is_archived) return "archived";
  const now = Date.now();
  if (new Date(a.publish_at).getTime() > now) return "scheduled";
  if (a.unpublish_at && new Date(a.unpublish_at).getTime() <= now) return "expired";
  return "live";
}
function scopeText(a) {
  if (a.all_departments) return "全公司";
  const ids = new Set((a.announcement_departments ?? []).map((x) => x.department_id));
  const names = S.departments.filter((d) => ids.has(d.id)).map((d) => d.name);
  return names.length ? names.join("、") : "未选部门";
}
const sortedAtts = (a) => [...(a.attachments ?? [])].sort((x, y) => x.sort_order - y.sort_order);

function friendly(err) {
  const msg = String(err?.message ?? err ?? ""), m = msg.toLowerCase(), code = err?.code ?? "";
  if (code === "invalid_credentials" || m.includes("invalid login credentials")) return "登录名或密码错误";
  if (code === "user_banned" || m.includes("banned")) return "帐号已停用，请联系管理员";
  if (code === "weak_password" || m.includes("password should")) return "密码太短或太简单";
  if (code === "same_password" || m.includes("different from the old")) return "新密码不能和旧密码相同";
  if (code === "23505" || m.includes("duplicate key")) return "名称已存在";
  if (code === "42501" || m.includes("row-level security")) return "没有权限执行这个操作";
  if (m.includes("exceeded the maximum") || m.includes("payload too large")) return "图片太大，单张上限 5 MB";
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed")) return "网络连接失败，请检查网络后重试";
  return msg || "发生未知错误";
}
const must = ({ data, error }) => { if (error) throw error; return data; };

// 本机已读记录（不上传，不做签收统计）
const readKey = () => `readIDs.${S.profile?.id}`;
const readIDs = () => { try { return new Set(JSON.parse(localStorage.getItem(readKey()) || "[]")); } catch { return new Set(); } };
function markRead(id) {
  const s = readIDs(); if (s.has(id)) return;
  s.add(id); try { localStorage.setItem(readKey(), JSON.stringify([...s])); } catch {}
}

// 私有桶图片：带登录 token 下载后转成 blob URL
const imgCache = new Map();
async function imageURL(path) {
  if (imgCache.has(path)) return imgCache.get(path);
  const blob = must(await sb.storage.from(CONFIG.bucket).download(path));
  const url = URL.createObjectURL(blob);
  imgCache.set(path, url);
  return url;
}
function hydrateImages(root = document) {
  root.querySelectorAll("img[data-path]:not([data-done])").forEach(async (img) => {
    img.dataset.done = "1";
    try { img.src = await imageURL(img.dataset.path); }
    catch { const ph = document.createElement("div"); ph.className = "ph"; ph.textContent = "图片载入失败"; img.replaceWith(ph); }
  });
}

// 上传前缩到长边 2000px 以内并转 JPEG
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  let w, h, src;
  if (bitmap) { w = bitmap.width; h = bitmap.height; src = bitmap; }
  else {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const ratio = Math.min(1, 2000 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * ratio); c.height = Math.round(h * ratio);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  let q = 0.85, blob;
  do { blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q)); q -= 0.15; } while (blob && blob.size > 4_500_000 && q > 0.3);
  if (!blob) throw new Error("无法读取这张图片");
  return { id: crypto.randomUUID(), blob, preview: URL.createObjectURL(blob) };
}

// ---------------------------------------------------------------- data
async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { S.profile = null; return; }
  const rows = must(await sb.from("profiles").select("*").eq("id", session.user.id));
  const me = rows[0];
  if (!me || !me.is_active) {
    await sb.auth.signOut();
    S.profile = null;
    throw new Error("帐号已停用，请联系管理员");
  }
  S.profile = me;
  S.departments = must(await sb.from("departments").select("id,name,sort_order").order("sort_order").order("name"));
}
async function loadAnns() {
  S.anns = must(await sb.from("announcements")
    .select("*,announcement_departments(department_id),attachments(id,storage_path,sort_order)")
    .order("is_pinned", { ascending: false }).order("publish_at", { ascending: false }).limit(500));
}
const loadUsers = async () => { S.users = must(await sb.from("profiles").select("*").order("is_active", { ascending: false }).order("username")); };
const loadDepts = async () => { S.departments = must(await sb.from("departments").select("id,name,sort_order").order("sort_order").order("name")); };
const loadLogs = async () => { S.logs = must(await sb.from("audit_log").select("*").order("created_at", { ascending: false }).limit(300)); };

async function adminAction(body) {
  const { data, error } = await sb.functions.invoke("admin", { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return data;
}

// ---------------------------------------------------------------- navigation
function go(view, replace = false) {
  S.view = view; S.error = ""; S.info = "";
  history[replace ? "replaceState" : "pushState"](view, "");
  window.scrollTo(0, 0);
  render();
}
const back = () => (history.state && history.length > 1 ? history.back() : go({ name: "list" }, true));
window.addEventListener("popstate", (e) => { S.view = e.state || { name: "list" }; S.error = ""; S.info = ""; render(); });

// ---------------------------------------------------------------- views
const bar = (title, { left = "", right = "" } = {}) =>
  `<header class="bar"><div class="side">${left}</div><h1>${esc(title)}</h1><div class="side right">${right}</div></header>`;
const backBtn = `<button class="link" data-act="back">‹ 返回</button>`;
const tabs = (on) => {
  const t = (name, ico, label) => `<button class="tab ${on === name ? "on" : ""}" data-act="tab" data-tab="${name}"><span class="ico">${ico}</span>${label}</button>`;
  return `<nav class="tabs"><div class="inner">${t("list", "📣", "公告")}${isAdmin() ? t("admin", "🛠️", "管理") : ""}${t("account", "👤", "我的")}</div></nav>`;
};
const msgs = () => `${S.error ? `<div class="err">${esc(S.error)}</div>` : ""}${S.info ? `<div class="ok">${esc(S.info)}</div>` : ""}`;
const loadingMain = `<main><div class="center-fill"><div class="spinner"></div></div></main>`;

function vLogin() {
  return `<div class="login">
    <div class="logo">📣</div><h1>公司公告</h1><p class="sub">请使用管理员发给你的帐号登录</p>
    <form data-form="login">
      <input type="text" name="username" placeholder="登录名" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
      <input type="password" name="password" placeholder="密码" autocomplete="current-password" required>
      ${msgs()}
      <button class="btn" ${S.busy ? "disabled" : ""}>${S.busy ? "登录中…" : "登录"}</button>
    </form>
    <p class="hint">忘记密码请联系管理员重置</p></div>`;
}

function vPassword(forced) {
  return `${bar(forced ? "设置新密码" : "修改密码", { left: forced ? "" : backBtn })}<main>
    ${forced ? `<div class="card"><div class="row">🔐 <div class="grow">这是你第一次登录或密码刚被重置，请先设置自己的密码。</div></div></div>` : ""}
    <form data-form="password">
      <div class="card">
        <div class="field"><label>新密码</label><input type="password" name="p1" autocomplete="new-password" required></div>
        <div class="field"><label>再输入一次</label><input type="password" name="p2" autocomplete="new-password" required></div>
      </div>
      <div class="foot">至少 8 位，需同时包含字母和数字。</div>
      ${msgs()}
      <button class="btn" ${S.busy ? "disabled" : ""}>保存新密码</button>
    </form>
    ${forced ? `<button class="btn red" data-act="signout" style="margin-top:10px">登出</button>` : ""}
  </main>`;
}

function vList() {
  const head = bar("公告", { right: isAdmin() ? `<button class="link" data-act="new-ann">＋ 发布</button>` : "" });
  if (!S.anns) return head + loadingMain + tabs("list");
  const q = S.search.trim().toLowerCase(), read = readIDs();
  const shown = S.anns.filter((a) => (!isAdmin() || statusOf(a) === S.filter) &&
    (!q || a.title.toLowerCase().includes(q) || (a.body ?? "").toLowerCase().includes(q)));
  const seg = isAdmin() ? `<div class="seg">${Object.entries(STATUS).map(([k, v]) =>
    `<button class="${S.filter === k ? "on" : ""}" data-act="filter" data-filter="${k}">${v}</button>`).join("")}</div>` : "";
  const rows = shown.map((a) => `<button class="row" data-act="open-ann" data-id="${a.id}"><div class="ann grow">
      <span class="dot ${read.has(a.id) ? "read" : ""}"></span><div class="grow">
      <h3>${a.is_pinned ? `<span class="pin">📌</span> ` : ""}${esc(a.title)}</h3>
      ${a.body ? `<p>${esc(a.body)}</p>` : ""}
      <div class="meta"><span>${fmt(a.publish_at)}</span>${a.author_initials ? `<span>署名 ${esc(a.author_initials)}</span>` : ""}
        ${a.attachments?.length ? `<span>🖼 ${a.attachments.length}</span>` : ""}${isAdmin() ? `<span>${esc(scopeText(a))}</span>` : ""}</div>
    </div></div></button>`).join("");
  return `${head}<main>
    <input class="search" type="search" placeholder="搜索标题或内容" value="${esc(S.search)}" data-input="search">
    ${seg}${msgs()}
    ${shown.length ? `<div class="card">${rows}</div>` : `<div class="empty"><div class="big">${q ? "🔍" : "📭"}</div>${q ? "找不到符合的公告" : "目前没有公告"}</div>`}
    <button class="btn ghost" data-act="refresh">刷新</button>
  </main>${tabs("list")}`;
}

function annBody(a, popup = false) {
  return `<div class="detail">
    ${popup ? `<div class="newtag">🔔 最新公告</div>` : ""}
    <h2>${a.is_pinned ? `<span class="pin">📌</span> ` : ""}${esc(a.title)}</h2>
    <div class="kv">
      <span>发布时间</span><span>${fmt(a.publish_at)}</span>
      ${a.unpublish_at ? `<span>有效至</span><span>${fmt(a.unpublish_at)}</span>` : ""}
      ${a.author_initials ? `<span>署名</span><span>${esc(a.author_initials)}</span>` : ""}
      <span>适用范围</span><span>${esc(scopeText(a))}</span>
      ${isAdmin() ? `<span>状态</span><span>${STATUS[statusOf(a)]}</span>` : ""}
    </div>
    <div class="body">${esc(a.body)}</div>
    <div class="imgs">${sortedAtts(a).map((t) => `<img data-path="${esc(t.storage_path)}" data-act="zoom" alt="公告图片">`).join("")}</div>
  </div>`;
}

function vDetail() {
  const a = S.anns?.find((x) => x.id === S.view.id);
  if (!a) return `${bar("公告", { left: backBtn })}<main><div class="empty">这则公告已不存在或你无权查看</div></main>`;
  const right = isAdmin() ? `<button class="link" data-act="edit-ann" data-id="${a.id}">编辑</button>` : "";
  return `${bar("公告", { left: backBtn, right })}<main>${annBody(a)}${msgs()}
    ${isAdmin() ? `<div style="margin-top:26px">${a.is_archived
      ? `<button class="btn ghost" data-act="archive" data-id="${a.id}" data-value="0">取消归档</button>`
      : `<button class="btn red" data-act="archive" data-id="${a.id}" data-value="1">归档</button>`}</div>` : ""}
  </main>`;
}

function vEditor() {
  const d = S.draft;
  const depts = d.all ? "" : S.departments.map((x) =>
    `<label class="check"><span>${esc(x.name)}</span><input type="checkbox" data-input="dept" value="${x.id}" ${d.depts.has(x.id) ? "checked" : ""}></label>`).join("");
  const count = d.kept.length + d.added.length;
  return `${bar(d.id ? "编辑公告" : "发布公告", {
      left: `<button class="link" data-act="back">取消</button>`,
      right: `<button class="link" data-act="save-ann" ${S.busy ? "disabled" : ""}>${S.busy ? "保存中…" : d.id ? "保存" : "发布"}</button>` })}<main>
    <div class="sect">内容</div>
    <div class="card">
      <div class="field"><label>标题</label><input type="text" data-input="d.title" value="${esc(d.title)}" placeholder="公告标题"></div>
      <div class="field"><label>正文</label><textarea data-input="d.body" placeholder="公告内容">${esc(d.body)}</textarea></div>
      <div class="field"><label>署名字母</label><input type="text" data-input="d.initials" value="${esc(d.initials)}" placeholder="例如 KC" autocapitalize="characters"></div>
    </div>
    <div class="sect">可见范围</div>
    <div class="card"><label class="check"><span>全公司可见</span><input type="checkbox" data-input="d.all" ${d.all ? "checked" : ""}></label>${depts}</div>
    ${d.all ? "" : `<div class="foot">只有勾选部门的员工能看到。</div>`}
    <div class="sect">时间</div>
    <div class="card">
      <label class="check"><span>置顶</span><input type="checkbox" data-input="d.pinned" ${d.pinned ? "checked" : ""}></label>
      <label class="check"><span>预约上架</span><input type="checkbox" data-input="d.scheduled" ${d.scheduled ? "checked" : ""}></label>
      ${d.scheduled ? `<div class="field"><label>上架时间</label><input type="datetime-local" data-input="d.publishAt" value="${d.publishAt}"></div>` : ""}
      <label class="check"><span>设定下架时间</span><input type="checkbox" data-input="d.hasExpiry" ${d.hasExpiry ? "checked" : ""}></label>
      ${d.hasExpiry ? `<div class="field"><label>下架时间</label><input type="datetime-local" data-input="d.unpublishAt" value="${d.unpublishAt}"></div>` : ""}
    </div>
    <div class="foot">${d.hasExpiry ? "到下架时间后自动归入「已到期」，员工不再看到。" : "不设下架时间即长期有效。"}</div>
    <div class="sect">图片（最多 ${CONFIG.maxImages} 张）</div>
    <div class="card"><div class="thumbs">
      ${d.kept.map((t) => `<div class="thumb"><img data-path="${esc(t.storage_path)}" alt=""><button data-act="rm-kept" data-id="${t.id}" aria-label="移除">✕</button></div>`).join("")}
      ${d.added.map((t) => `<div class="thumb"><img src="${t.preview}" alt=""><button data-act="rm-added" data-id="${t.id}" aria-label="移除">✕</button></div>`).join("")}
      ${count < CONFIG.maxImages ? `<label class="thumb add">＋<input type="file" accept="image/*" multiple hidden data-input="files"></label>` : ""}
    </div></div>
    ${msgs()}
  </main>`;
}

function vAdmin() {
  const link = (act, ico, label) => `<button class="row" data-act="${act}"><span>${ico}</span><span class="grow">${label}</span><span class="chev">›</span></button>`;
  return `${bar("管理")}<main><div class="card">
    ${link("nav-users", "👥", "员工帐号")}${isSuper() ? link("nav-depts", "🏢", "部门") : ""}${link("nav-logs", "📋", "操作日志")}
  </div><div class="foot">发布与编辑公告请到「公告」页右上角。</div></main>${tabs("admin")}`;
}

function vUsers() {
  const head = bar("员工帐号", { left: backBtn, right: `<button class="link" data-act="nav-user-new">＋ 新增</button>` });
  if (!S.users) return head + loadingMain;
  const q = S.userSearch.trim().toLowerCase();
  const list = S.users.filter((u) => !q || u.display_name.toLowerCase().includes(q) || u.username.includes(q));
  const row = (u) => `<button class="row ${u.is_active ? "" : "dim"}" data-act="open-user" data-id="${u.id}"><div class="grow">
      <div>${esc(u.display_name)} ${u.role !== "staff" ? `<span class="badge">${ROLE[u.role]}</span>` : ""}
        ${u.must_change_password && u.is_active ? `<span class="badge warn">未改密</span>` : ""}</div>
      <div class="meta">${esc(u.username)} · ${esc(deptName(u.department_id))}</div></div><span class="chev">›</span></button>`;
  const active = list.filter((u) => u.is_active), inactive = list.filter((u) => !u.is_active);
  return `${head}<main>
    <input class="search" type="search" placeholder="搜索姓名或登录名" value="${esc(S.userSearch)}" data-input="userSearch">${msgs()}
    <div class="sect">在职（${active.length}）</div><div class="card">${active.map(row).join("") || `<div class="row val">无</div>`}</div>
    ${inactive.length ? `<div class="sect">已停用（${inactive.length}）</div><div class="card">${inactive.map(row).join("")}</div>` : ""}
  </main>`;
}

const deptOptions = (sel) => `<option value="">未分配</option>` + S.departments.map((d) => `<option value="${d.id}" ${d.id === sel ? "selected" : ""}>${esc(d.name)}</option>`).join("");
const roleOptions = (sel) => Object.entries(ROLE).reverse().map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${v}</option>`).join("");

function vUserNew() {
  return `${bar("新增帐号", { left: backBtn })}<main><form data-form="user-new">
    <div class="card">
      <div class="field"><label>登录名（小写字母 / 数字）</label><input type="text" name="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></div>
      <div class="field"><label>姓名</label><input type="text" name="display_name" required></div>
      <div class="field"><label>署名字母（选填）</label><input type="text" name="initials" placeholder="例如 KC" autocapitalize="characters"></div>
    </div>
    <div class="foot">登录名建立后不能修改。密码由系统自动生成，下一步显示。</div>
    <div class="card">
      <div class="field"><label>部门</label><select name="department_id">${deptOptions("")}</select></div>
      ${isSuper() ? `<div class="field"><label>身份</label><select name="role">${roleOptions("staff")}</select></div>` : ""}
    </div>
    ${msgs()}<button class="btn" ${S.busy ? "disabled" : ""}>${S.busy ? "建立中…" : "建立帐号"}</button>
  </form></main>`;
}

function vUser() {
  const u = S.users?.find((x) => x.id === S.view.id);
  if (!u) return `${bar("员工", { left: backBtn })}<main><div class="empty">找不到这个帐号</div></main>`;
  const self = u.id === S.profile.id, canManage = isSuper() || u.role !== "super_admin", dis = canManage ? "" : "disabled";
  return `${bar(u.display_name, { left: backBtn })}<main><form data-form="user-edit" data-id="${u.id}">
    <div class="card">
      <div class="row"><span class="grow">登录名</span><span class="val">${esc(u.username)}</span></div>
      <div class="field"><label>姓名</label><input type="text" name="display_name" value="${esc(u.display_name)}" ${dis} required></div>
      <div class="field"><label>署名字母</label><input type="text" name="initials" value="${esc(u.initials)}" autocapitalize="characters" ${dis}></div>
      <div class="field"><label>部门</label><select name="department_id" ${dis}>${deptOptions(u.department_id)}</select></div>
      ${isSuper() && !self ? `<div class="field"><label>身份</label><select name="role">${roleOptions(u.role)}</select></div>`
        : `<div class="row"><span class="grow">身份</span><span class="val">${ROLE[u.role]}</span></div>`}
    </div>
    ${u.is_active ? "" : `<div class="foot">此帐号已停用，无法登录。</div>`}
    ${msgs()}
    ${canManage ? `<button class="btn" ${S.busy ? "disabled" : ""}>保存修改</button>` : `<div class="foot">普通管理员不能修改主管理员。</div>`}
  </form>
  ${canManage ? `<div style="margin-top:22px">
    <button class="btn ghost" data-act="reset-pw" data-id="${u.id}" ${S.busy ? "disabled" : ""}>重置密码</button>
    ${self ? "" : `<button class="btn ${u.is_active ? "red" : "ghost"}" data-act="toggle-active" data-id="${u.id}" ${S.busy ? "disabled" : ""}>${u.is_active ? "停用帐号（离职）" : "重新启用帐号"}</button>`}
  </div>` : ""}</main>`;
}

function vDepts() {
  return `${bar("部门", { left: backBtn })}<main>
    <form data-form="dept-new" class="card"><div class="field"><label>新增部门</label>
      <div style="display:flex;gap:8px"><input type="text" name="name" placeholder="部门名称" required><button class="link">新增</button></div></div></form>
    ${msgs()}
    <div class="sect">现有部门</div>
    <div class="card">${S.departments.map((d) => `<div class="row"><span class="grow">${esc(d.name)}</span>
      <button class="link" data-act="dept-rename" data-id="${d.id}">改名</button><button class="link danger" data-act="dept-delete" data-id="${d.id}">删除</button></div>`).join("")}</div>
    <div class="foot">删除部门后，该部门员工变成「未分配」，只能看到全公司公告。</div></main>`;
}

function vLogs() {
  const head = bar("操作日志", { left: backBtn });
  if (!S.logs) return head + loadingMain;
  const summary = (e) => {
    const d = e.detail ?? {};
    if (d.title) return d.title;
    let s = d.display_name ?? d.username ?? "";
    if (d.display_name && d.username) s += `（${d.username}）`;
    if (e.action === "set_role" && d.role) s += ` → ${ROLE[d.role] ?? d.role}`;
    return s;
  };
  return `${head}<main>${msgs()}${S.logs.length ? `<div class="card">${S.logs.map((e) => `<div class="row"><div class="grow">
      <div style="display:flex;justify-content:space-between;gap:10px"><b>${esc(ACTION[e.action] ?? e.action)}</b><span class="meta">${fmt(e.created_at)}</span></div>
      <div>${esc(summary(e))}</div><div class="meta">操作人 ${esc(e.actor_initials || "系统")}</div></div></div>`).join("")}</div>`
    : `<div class="empty"><div class="big">📋</div>还没有记录</div>`}</main>`;
}

function vAccount() {
  const p = S.profile, kv = (k, v) => `<div class="row"><span class="grow">${k}</span><span class="val">${esc(v)}</span></div>`;
  return `${bar("我的")}<main>
    <div class="card">${kv("姓名", p.display_name)}${kv("登录名", p.username)}${kv("部门", deptName(p.department_id))}${kv("身份", ROLE[p.role])}</div>
    <div class="card"><button class="row" data-act="nav-password"><span class="grow">修改密码</span><span class="chev">›</span></button></div>
    <button class="btn red" data-act="signout-confirm">登出</button>
    <div class="foot" style="text-align:center;margin-top:18px">提示：手机浏览器选「加入主屏幕」，可像 App 一样打开。</div>
  </main>${tabs("account")}`;
}

// ---------------------------------------------------------------- render
function render() {
  let html;
  if (!S.ready) html = `<div class="center-fill"><div class="spinner"></div></div>`;
  else if (!S.profile) html = vLogin();
  else if (S.profile.must_change_password) html = vPassword(true);
  else {
    const n = S.view.name;
    if (!isAdmin() && ["admin", "users", "user", "user-new", "depts", "logs", "editor"].includes(n)) S.view = { name: "list" };
    html = ({ list: vList, detail: vDetail, editor: vEditor, admin: vAdmin, users: vUsers, "user-new": vUserNew,
      user: vUser, depts: vDepts, logs: vLogs, account: vAccount, password: () => vPassword(false) }[S.view.name] ?? vList)();
  }
  // 重绘时保住输入焦点（搜索框）
  const active = document.activeElement?.dataset?.input, pos = document.activeElement?.selectionStart;
  $app.innerHTML = html;
  if (active === "search" || active === "userSearch") {
    const el = $app.querySelector(`[data-input="${active}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
  }
  hydrateImages($app);
}

// ---------------------------------------------------------------- modals
function closeModal() { $modal.innerHTML = ""; }
function confirmModal({ title, text, okLabel, danger = false }) {
  return new Promise((resolve) => {
    $modal.innerHTML = `<div class="overlay"><div class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p>
      <button class="btn ${danger ? "red" : ""}" data-m="ok">${esc(okLabel)}</button><button class="btn ghost" data-m="cancel">取消</button></div></div>`;
    $modal.onclick = (e) => {
      const m = e.target.dataset.m;
      if (m || e.target.classList.contains("overlay")) { closeModal(); $modal.onclick = null; resolve(m === "ok"); }
    };
  });
}
function promptModal({ title, value }) {
  return new Promise((resolve) => {
    $modal.innerHTML = `<div class="overlay"><form class="modal"><h3>${esc(title)}</h3>
      <input type="text" value="${esc(value)}" style="margin-bottom:16px" required>
      <button class="btn">保存</button><button type="button" class="btn ghost" data-m="cancel">取消</button></form></div>`;
    const form = $modal.querySelector("form"), input = form.querySelector("input");
    input.focus(); input.select();
    form.onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); closeModal(); resolve(v || null); };
    $modal.onclick = (e) => { if (e.target.dataset.m === "cancel" || e.target.classList.contains("overlay")) { closeModal(); $modal.onclick = null; resolve(null); } };
  });
}
function credentialModal({ username, password }, isNew) {
  const text = `登录名：${username}\n初始密码：${password}\n首次登录后请立即修改密码。`;
  return new Promise((resolve) => {
    $modal.innerHTML = `<div class="overlay"><div class="modal"><h3>🔑 ${isNew ? "帐号已建立" : "密码已重置"}</h3>
      <p>密码只显示这一次，关闭后无法再查看。</p>
      <div class="cred"><div><span>登录名</span><b>${esc(username)}</b></div><div><span>初始密码</span><b>${esc(password)}</b></div></div>
      <button class="btn" data-m="copy">复制登录名和密码</button><button class="btn ghost" data-m="done">完成</button></div></div>`;
    $modal.onclick = async (e) => {
      if (e.target.dataset.m === "copy") {
        try { await navigator.clipboard.writeText(text); e.target.textContent = "已复制 ✓"; }
        catch { e.target.textContent = "复制失败，请长按密码手动复制"; }
      } else if (e.target.dataset.m === "done") { closeModal(); $modal.onclick = null; resolve(); }
    };
  });
}
function popupAnnouncement(a) {
  markRead(a.id);
  $modal.innerHTML = `<div class="overlay"><div class="modal wide">${annBody(a, true)}
    <button class="btn" data-m="done" style="margin-top:20px">知道了</button></div></div>`;
  hydrateImages($modal);
  $modal.onclick = (e) => {
    if (e.target.dataset.act === "zoom") return lightbox(e.target.src);
    if (e.target.dataset.m === "done" || e.target.classList.contains("overlay")) { closeModal(); $modal.onclick = null; render(); }
  };
}
function lightbox(src) {
  if (!src) return;
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${src}" alt="">`;
  let zoomed = false;
  box.onclick = () => { if (zoomed) box.remove(); else { zoomed = true; box.classList.add("zoom"); } };
  box.ondblclick = () => box.remove();
  document.body.appendChild(box);
}

// ---------------------------------------------------------------- actions
async function run(fn) {
  if (S.busy) return;
  S.busy = true; S.error = ""; S.info = ""; render();
  try { await fn(); } catch (e) { S.error = friendly(e); await checkSession(); }
  S.busy = false; render();
}
async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session && S.profile) { S.profile = null; S.anns = S.users = S.logs = null; }
}

async function refreshAnns({ popup = false } = {}) {
  try {
    await loadAnns();
    if (popup && !S.popupShown) {
      S.popupShown = true;
      const live = S.anns.filter((a) => statusOf(a) === "live").sort((x, y) => new Date(y.publish_at) - new Date(x.publish_at));
      if (live[0] && !readIDs().has(live[0].id)) popupAnnouncement(live[0]);
    }
  } catch (e) { S.error = friendly(e); S.anns ??= []; }
  render();
}

function newDraft(a) {
  const soon = new Date(Date.now() + 3600e3), month = new Date(Date.now() + 30 * 86400e3);
  return a ? {
    id: a.id, title: a.title, body: a.body ?? "", initials: a.author_initials ?? "", all: a.all_departments,
    depts: new Set((a.announcement_departments ?? []).map((x) => x.department_id)), pinned: a.is_pinned,
    scheduled: new Date(a.publish_at) > new Date(), publishAt: toLocalInput(a.publish_at), originalPublishAt: a.publish_at,
    hasExpiry: !!a.unpublish_at, unpublishAt: toLocalInput(a.unpublish_at ?? month), kept: sortedAtts(a), removed: [], added: [],
  } : {
    id: null, title: "", body: "", initials: S.profile.initials ?? "", all: true, depts: new Set(), pinned: false,
    scheduled: false, publishAt: toLocalInput(soon), originalPublishAt: null,
    hasExpiry: false, unpublishAt: toLocalInput(month), kept: [], removed: [], added: [],
  };
}

async function saveAnnouncement() {
  const d = S.draft, title = d.title.trim();
  if (!title) throw new Error("请填标题");
  if (!d.all && !d.depts.size) throw new Error("请至少选一个部门，或打开「全公司可见」");
  // 新公告不预约 = 立即；旧公告不预约 = 保持原上架时间（若原本是未来则改为现在）
  const now = new Date();
  const publish = d.scheduled ? new Date(d.publishAt)
    : d.originalPublishAt ? new Date(Math.min(new Date(d.originalPublishAt).getTime(), now.getTime())) : now;
  if (isNaN(publish)) throw new Error("上架时间无效");
  let unpublish = null;
  if (d.hasExpiry) {
    unpublish = new Date(d.unpublishAt);
    if (isNaN(unpublish)) throw new Error("下架时间无效");
    if (unpublish <= publish) throw new Error("下架时间必须晚于上架时间");
  }
  const id = d.id ?? crypto.randomUUID();
  const fields = { title, body: d.body.trim(), author_initials: d.initials.trim().toUpperCase(), all_departments: d.all,
    is_pinned: d.pinned, publish_at: publish.toISOString(), unpublish_at: unpublish ? unpublish.toISOString() : null };
  if (d.id) must(await sb.from("announcements").update(fields).eq("id", id));
  else must(await sb.from("announcements").insert({ id, ...fields }));

  must(await sb.from("announcement_departments").delete().eq("announcement_id", id));
  if (!d.all) must(await sb.from("announcement_departments").insert([...d.depts].map((x) => ({ announcement_id: id, department_id: x }))));

  for (const t of d.removed) {
    must(await sb.from("attachments").delete().eq("id", t.id));
    await sb.storage.from(CONFIG.bucket).remove([t.storage_path]);
    imgCache.delete(t.storage_path);
  }
  let order = d.kept.length;
  for (const img of d.added) {
    const path = `${id}/${crypto.randomUUID()}.jpg`;
    must(await sb.storage.from(CONFIG.bucket).upload(path, img.blob, { contentType: "image/jpeg" }));
    must(await sb.from("attachments").insert({ announcement_id: id, storage_path: path, sort_order: order++ }));
  }
  S.draft = null;
  await loadAnns();
  S.filter = statusOf(S.anns.find((a) => a.id === id) ?? { publish_at: publish.toISOString() });
  go({ name: "list" }, true);
}

const actions = {
  back,
  tab: (el) => { go({ name: el.dataset.tab }); if (el.dataset.tab === "list") refreshAnns(); },
  refresh: () => { S.anns = null; render(); refreshAnns(); },
  filter: (el) => { S.filter = el.dataset.filter; render(); },
  "open-ann": (el) => { markRead(el.dataset.id); go({ name: "detail", id: el.dataset.id }); },
  "new-ann": () => { S.draft = newDraft(null); go({ name: "editor" }); },
  "edit-ann": (el) => { S.draft = newDraft(S.anns.find((a) => a.id === el.dataset.id)); go({ name: "editor" }); },
  "save-ann": () => run(saveAnnouncement),
  "rm-kept": (el) => { const d = S.draft, t = d.kept.find((x) => x.id === el.dataset.id); d.kept = d.kept.filter((x) => x !== t); d.removed.push(t); render(); },
  "rm-added": (el) => { S.draft.added = S.draft.added.filter((x) => x.id !== el.dataset.id); render(); },
  zoom: (el) => lightbox(el.src),
  archive: async (el) => {
    const on = el.dataset.value === "1";
    if (on && !(await confirmModal({ title: "归档这则公告？", text: "归档后员工将看不到，管理员仍可在「已归档」找到。", okLabel: "归档", danger: true }))) return;
    run(async () => { must(await sb.from("announcements").update({ is_archived: on }).eq("id", el.dataset.id)); await loadAnns(); back(); });
  },
  "nav-users": () => { go({ name: "users" }); loadUsers().catch((e) => { S.error = friendly(e); S.users ??= []; }).finally(render); },
  "nav-user-new": () => go({ name: "user-new" }),
  "open-user": (el) => go({ name: "user", id: el.dataset.id }),
  "nav-depts": () => { go({ name: "depts" }); loadDepts().then(render); },
  "nav-logs": () => { S.logs = null; go({ name: "logs" }); loadLogs().catch((e) => { S.error = friendly(e); S.logs ??= []; }).finally(render); },
  "nav-password": () => go({ name: "password" }),
  "reset-pw": async (el) => {
    if (!(await confirmModal({ title: "重置密码？", text: "旧密码立即失效，系统会生成新密码给你转发。", okLabel: "重置密码", danger: true }))) return;
    run(async () => { const cred = await adminAction({ action: "reset_password", user_id: el.dataset.id }); await loadUsers(); S.busy = false; render(); await credentialModal(cred, false); });
  },
  "toggle-active": async (el) => {
    const u = S.users.find((x) => x.id === el.dataset.id), off = u.is_active;
    if (!(await confirmModal({ title: off ? "停用这个帐号？" : "重新启用？", text: off ? "停用后此人立即无法登录，资料和日志会保留。" : "启用后此人可用原密码登录。", okLabel: off ? "停用" : "启用", danger: off }))) return;
    run(async () => { await adminAction({ action: "set_active", user_id: u.id, is_active: !off }); await loadUsers(); S.info = off ? "已停用" : "已启用"; });
  },
  "dept-rename": async (el) => {
    const d = S.departments.find((x) => x.id === el.dataset.id), name = await promptModal({ title: "部门改名", value: d.name });
    if (name && name !== d.name) run(async () => { must(await sb.from("departments").update({ name }).eq("id", d.id)); await loadDepts(); });
  },
  "dept-delete": async (el) => {
    const d = S.departments.find((x) => x.id === el.dataset.id);
    if (!(await confirmModal({ title: `删除「${d.name}」？`, text: "该部门员工会变成「未分配」，只能看到全公司公告。", okLabel: "删除", danger: true }))) return;
    run(async () => { must(await sb.from("departments").delete().eq("id", d.id)); await loadDepts(); });
  },
  "signout-confirm": async () => { if (await confirmModal({ title: "确定登出？", text: "", okLabel: "登出", danger: true })) actions.signout(); },
  signout: async () => { await sb.auth.signOut(); Object.assign(S, { profile: null, anns: null, users: null, logs: null, popupShown: false, view: { name: "list" } }); render(); },
};

const forms = {
  login: (f) => run(async () => {
    const name = f.username.value.trim().toLowerCase(), email = name.includes("@") ? name : `${name}@${CONFIG.emailDomain}`;
    must(await sb.auth.signInWithPassword({ email, password: f.password.value }));
    await loadProfile();
    S.view = { name: "list" }; history.replaceState(S.view, "");
    if (!S.profile.must_change_password) refreshAnns({ popup: true });
  }),
  password: (f) => run(async () => {
    const p = f.p1.value;
    if (p.length < 8) throw new Error("密码至少 8 位");
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw new Error("密码需同时包含字母和数字");
    if (p !== f.p2.value) throw new Error("两次输入不一致");
    const forced = S.profile.must_change_password;
    must(await sb.auth.updateUser({ password: p }));
    must(await sb.rpc("mark_password_changed"));
    S.profile.must_change_password = false;
    if (forced) { S.view = { name: "list" }; history.replaceState(S.view, ""); refreshAnns({ popup: true }); }
    else { S.view = { name: "account" }; history.replaceState(S.view, ""); S.info = "密码已更新"; }
  }),
  "user-new": (f) => run(async () => {
    const username = f.username.value.trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw new Error("登录名只能用小写字母、数字、. _ -，长度 2 到 32");
    const cred = await adminAction({ action: "create_user", username, display_name: f.display_name.value.trim(),
      initials: f.initials.value.trim().toUpperCase(), role: f.role?.value ?? "staff", department_id: f.department_id.value || null });
    await loadUsers(); S.busy = false; S.view = { name: "users" }; history.replaceState(S.view, ""); render();
    await credentialModal(cred, true);
  }),
  "user-edit": (f) => run(async () => {
    const id = f.dataset.id, u = S.users.find((x) => x.id === id);
    must(await sb.from("profiles").update({ display_name: f.display_name.value.trim(), initials: f.initials.value.trim().toUpperCase(),
      department_id: f.department_id.value || null }).eq("id", id));
    if (f.role && f.role.value !== u.role) await adminAction({ action: "set_role", user_id: id, role: f.role.value });
    await loadUsers();
    if (id === S.profile.id) await loadProfile();
    S.info = "已保存";
  }),
  "dept-new": (f) => run(async () => {
    const next = Math.max(0, ...S.departments.map((d) => d.sort_order)) + 1;
    must(await sb.from("departments").insert({ name: f.name.value.trim(), sort_order: next }));
    await loadDepts();
  }),
};

// ---------------------------------------------------------------- events
$app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  e.preventDefault();
  actions[el.dataset.act]?.(el);
});
$app.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-form]");
  if (!f) return;
  e.preventDefault();
  forms[f.dataset.form]?.(f);
});
$app.addEventListener("input", (e) => {
  const key = e.target.dataset.input;
  if (!key) return;
  if (key === "search" || key === "userSearch") { S[key] = e.target.value; render(); return; }
  const d = S.draft; if (!d) return;
  if (key === "d.title") d.title = e.target.value;
  else if (key === "d.body") d.body = e.target.value;
  else if (key === "d.initials") d.initials = e.target.value;
  else if (key === "d.publishAt") d.publishAt = e.target.value;
  else if (key === "d.unpublishAt") d.unpublishAt = e.target.value;
});
$app.addEventListener("change", async (e) => {
  const key = e.target.dataset.input, d = S.draft;
  if (!key || !d) return;
  if (key === "d.all") { d.all = e.target.checked; render(); }
  else if (key === "d.pinned") d.pinned = e.target.checked;
  else if (key === "d.scheduled") { d.scheduled = e.target.checked; render(); }
  else if (key === "d.hasExpiry") { d.hasExpiry = e.target.checked; render(); }
  else if (key === "dept") { e.target.checked ? d.depts.add(e.target.value) : d.depts.delete(e.target.value); }
  else if (key === "files") {
    const room = CONFIG.maxImages - d.kept.length - d.added.length;
    S.error = "";
    for (const file of [...e.target.files].slice(0, room)) {
      try { d.added.push(await prepareImage(file)); } catch (err) { S.error = friendly(err); }
    }
    render();
  }
});

// 回到页面时重新确认帐号仍在职
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !S.profile) return;
  try { await loadProfile(); } catch (e) { S.error = friendly(e); }
  if (!S.profile) { S.anns = S.users = S.logs = null; }
  render();
});
sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT" && S.profile) { S.profile = null; S.anns = S.users = S.logs = null; render(); }
});

// ---------------------------------------------------------------- boot
(async () => {
  try { await loadProfile(); } catch (e) { S.error = friendly(e); }
  S.ready = true;
  history.replaceState(S.view, "");
  render();
  if (S.profile && !S.profile.must_change_password) refreshAnns({ popup: true });
})();
