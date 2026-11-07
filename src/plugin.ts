const TIMELINE_CAPABILITY = "flare.datasource.timeline/v1";
const TAB_CATALOG_CAPABILITY = "flare.datasource.tab-catalog/v1";
const POST_CAPABILITY = "flare.datasource.post/v1";

const TIEBA_HOST = "tieba.baidu.com";
const TIEBA_ORIGIN = "https://" + TIEBA_HOST;

const THREADS_PER_PAGE = 30;
const MAX_FORUM_PAGES = 200;
const MAX_THREAD_PAGES = 400;

const HTML_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "X-Requested-With": "com.baidu.tieba",
};

const JSON_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "com.baidu.tieba",
};

type JsonObject = Record<string, unknown>;
type TiebaCookie = { name: string; value: string };

type ThreadFloor = {
  tid: string;
  pid: string;
  floor: number;
  userName: string;
  displayName: string;
  portrait: string;
  contentHtml: string;
  title: string;
  timeText: string;
};

defineFlareSocialPlugin({
  detector: {
    detect(request) {
      if (request.origin.toLowerCase() !== TIEBA_ORIGIN) {
        return { match: "none", canonicalOrigin: request.origin };
      }
      return {
        match: "exact",
        canonicalOrigin: request.origin,
        software: "Baidu Tieba",
        instance: {
          domain: TIEBA_HOST,
          title: "百度贴吧",
          description: "Baidu Tieba forums, threads and replies",
        },
      };
    },
  },
  login: {
    browser: {
      async begin(_request, context) {
        return { type: "webCookie", startUrl: context.origin + "/" };
      },
      async check(request, context) {
        const probeUrl = context.origin + "/mo/q/newmoindex?need_user=1";
        const cookies = request.cookies.cookies
          .filter((cookie) => cookie.sourceUrl === probeUrl)
          .map(({ name, value }) => ({ name, value }));
        if (!hasCookie(cookies, "BDUSS") || !hasCookie(cookies, "BAIDUID")) {
          return { type: "pending" };
        }
        const response = await hostRequest({
          url: probeUrl,
          cookies,
          headers: JSON_HEADERS,
        });
        if (response.status < 200 || response.status >= 300) {
          fail("Remote", "The website rejected the sign-in check");
        }
        const root = parseJsonObject(response.body);
        const data = asObject(root?.data);
        if (!data || !isLoggedIn(data.is_login)) return { type: "pending" };
        const uid = text(data.uid);
        if (!/^\d+$/.test(uid)) return { type: "pending" };
        const handle = text(data.name).trim() || uid;
        const displayName = text(data.name_show).trim() || handle;
        return {
          type: "success",
          value: {
            accountId: uid,
            origin: context.origin,
            credential: { cookies },
            profile: {
              key: { id: uid, host: accountHost(context) },
              handle,
              displayName,
              avatarUrl: avatarUrl(text(data.portrait_url)),
            },
            capabilities: {
              [TIMELINE_CAPABILITY]: ["page"],
              [TAB_CATALOG_CAPABILITY]: ["page"],
              [POST_CAPABILITY]: ["detail", "context"],
            },
          },
        };
      },
    },
  },
  capabilities: {
    timeline: {
      async page(request, context) {
        if (request.page.direction === "newer") {
          fail("Unsupported", "This timeline does not support newer pages");
        }
        if (request.timelineId === "hot") {
          return loadHot(request.page, context);
        }
        const parameters = { ...request.page.parameters, ...request.parameters };
        const forum = text(parameters.kw).trim();
        if (!forum) fail("Unsupported", "This timeline does not identify a forum");
        return loadForum(forum, request.page, context);
      },
    },
    tabCatalog: {
      async page(_request, context) {
        const data = await requestData(
          "/mg/o/getForumHome?st=0&pn=0&rn=50&eqid=&refer=",
          context,
        );
        const sections: TimelineSectionV1[] = [];
        const liked = forumDescriptors(asObject(data.like_forum)?.list);
        if (liked.length) {
          sections.push({
            id: "liked",
            title: { value: "我关注的吧" },
            timelines: { items: liked, endReached: true },
          });
        }
        const recommended = forumDescriptors(data.recomm_forum);
        if (recommended.length) {
          sections.push({
            id: "recommended",
            title: { value: "推荐吧" },
            timelines: { items: recommended, endReached: true },
          });
        }
        if (!sections.length) fail("Remote", "The forum catalog is empty");
        return { items: sections, endReached: true };
      },
    },
    post: {
      async detail(request, context) {
        const id = request.key.id;
        const tid = threadIdOf(id);
        if (!tid) fail("NotFound", "The requested thread does not exist");
        const floors = parseThreadPage(await requestHtml(threadPagePath(tid, 1), context));
        if (id.startsWith("p")) {
          const pid = id.slice(id.indexOf("_") + 1);
          const direct = floors.find((item) => item.pid === pid);
          if (direct) return { post: mapFloor(direct, tid, context, true) };
        }
        const first = floors[0];
        if (!first) fail("NotFound", "The requested thread does not exist");
        return { post: mapThreadDetail(first, tid, context) };
      },
      async context(request, context) {
        const tid = threadIdOf(request.key.id);
        if (!tid) fail("NotFound", "The requested thread does not exist");
        const page =
          request.page.direction === "refresh"
            ? 1
            : parsePositiveInt(request.page.cursor);
        if (page === null || page > MAX_THREAD_PAGES) {
          fail("Validation", "Invalid page cursor");
        }
        const floors = parseThreadPage(
          await requestHtml(threadPagePath(tid, page), context),
        );
        if (!floors.length) return { items: [], endReached: true };
        const visible = page === 1 ? floors.slice(1) : floors;
        const items: TimelineItemV1[] = visible
          .slice(0, request.page.limit)
          .map((floor) => ({
            type: "post" as const,
            post: mapFloor(floor, tid, context, false),
          }));
        const endReached = floors.length < 30;
        return {
          items,
          olderCursor: endReached ? undefined : String(page + 1),
          endReached,
        };
      },
    },
  },
});

async function loadHot(
  page: PageRequestV1,
  context: PluginInvocationContextV1,
): Promise<PageV1<TimelineItemV1>> {
  if (page.direction !== "refresh") return { items: [], endReached: true };
  const data = await requestData("/mo/q/hotMessage/list?fr=newwise", context);
  const list = asObject(data.list);
  const entries = list && Array.isArray(list.ret) ? list.ret : [];
  const items: TimelineItemV1[] = [];
  for (const entry of entries) {
    const item = mapHotTopic(entry);
    if (item) items.push(item);
    if (items.length >= page.limit) break;
  }
  return { items, endReached: true };
}

async function loadForum(
  forum: string,
  page: PageRequestV1,
  context: PluginInvocationContextV1,
): Promise<PageV1<TimelineItemV1>> {
  const pageNumber =
    page.direction === "refresh" ? 1 : parsePositiveInt(page.cursor);
  if (pageNumber === null || pageNumber > MAX_FORUM_PAGES) {
    fail("Validation", "Invalid page cursor");
  }
  const html = await requestHtml(
    "/mo/q/m?kw=" + encodeURIComponent(forum) + "&pn=" + String(pageNumber),
    context,
  );
  const threads = parseForumList(html);
  if (!threads.length) {
    if (pageNumber === 1) fail("InvalidResponse", "The forum page contained no threads");
    return { items: [], endReached: true };
  }
  const items: TimelineItemV1[] = [];
  for (const thread of threads) {
    const item = mapThreadItem(thread, forum, context);
    if (item) items.push(item);
    if (items.length >= page.limit) break;
  }
  return {
    items,
    olderCursor: String(pageNumber + 1),
    endReached: false,
  };
}

type ForumThread = {
  tid: string;
  title: string;
  authorName: string;
  authorUrl: string;
  timeText: string;
  replyCount: number | undefined;
  top: boolean;
  images: string[];
  avatar: string;
};

function parseForumList(html: string): ForumThread[] {
  const threads: ForumThread[] = [];
  const pattern =
    /<li class="(tl_top|tl_shadow)[^"]*"\s+data-tid="(\d+)"([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const kind = match[1];
    const tid = match[2];
    const body = match[3];
    const authorBlock = /<div class="ti_author_time"([^>]*)>([\s\S]*?)<\/div>\s*<\/div>/.exec(body);
    const authorName = authorBlock
      ? stripTags(/<span class="ti_author">([\s\S]*?)<\/span>/.exec(authorBlock[2])?.[1] ?? "").trim()
      : "";
    const authorUrl = authorBlock
      ? (/data-url="([^"]*)"/.exec(authorBlock[1])?.[1] ?? "")
      : "";
    const timeText = /<span class="ti_time">([^<]*)<\/span>/.exec(body)?.[1]?.trim() ?? "";
    const titleRaw = /<div class="ti_title">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? "";
    const title = stripTags(titleRaw).replace(/\s+/g, " ").trim();
    if (!tid || !title) continue;
    const replyMatch = /class="btn_icon">(\d+)<\/span>/.exec(body);
    const images: string[] = [];
    const imagePattern = /data-url="(https?:\/\/[^"]+?\.(?:jpg|jpeg|png|gif|webp)[^"]*)"/gi;
    let imageMatch: RegExpExecArray | null;
    while ((imageMatch = imagePattern.exec(body)) !== null) {
      const url = normalizeUrl(decodeEntities(imageMatch[1]));
      if (!images.includes(url)) images.push(url);
      if (images.length >= 9) break;
    }
    const avatar = /<div class="ti_avatar"[^>]*>\s*<img src="([^"]+)"/.exec(body)?.[1] ?? "";
    threads.push({
      tid,
      title,
      authorName,
      authorUrl,
      timeText,
      replyCount: replyMatch ? Number(replyMatch[1]) : undefined,
      top: kind === "tl_top",
      images,
      avatar: avatar ? normalizeUrl(decodeEntities(avatar)) : "",
    });
  }
  return threads;
}

function mapThreadItem(
  thread: ForumThread,
  forum: string,
  context: PluginInvocationContextV1,
): TimelineItemV1 | undefined {
  const media: MediaV1[] | undefined = thread.images.length
    ? thread.images.map((url, index) => ({
        id: thread.tid + "-img" + String(index),
        type: "image" as const,
        url,
      }))
    : undefined;
  const post: PostV1 = {
    key: { id: "t" + thread.tid, host: accountHost(context) },
    author: threadAuthor(thread, context),
    createdAt: parseTiebaTime(thread.timeText) ?? new Date().toISOString(),
    content: { format: "html", value: threadContentHtml(thread) },
    media,
    detailType: "post",
    url: threadUrl(thread.tid),
    repliesCount: thread.replyCount,
  };
  return { type: "post", post };
}

function threadAuthor(
  thread: ForumThread,
  context: PluginInvocationContextV1,
): ProfileV1 | undefined {
  const handle = thread.authorName.trim();
  if (!handle) return undefined;
  const idMatch = /[?&]un=([^&]+)/.exec(thread.authorUrl);
  const id = idMatch ? decodeEntities(idMatch[1]) : handle;
  return {
    key: { id, host: accountHost(context) },
    handle,
    displayName: handle,
    avatarUrl: thread.avatar ? thread.avatar : undefined,
  };
}

function threadContentHtml(thread: ForumThread): string {
  const parts: string[] = [];
  if (thread.top) parts.push('<span class="tieba-top">置顶</span> ');
  parts.push("<b>" + escapeHtml(thread.title) + "</b>");
  return parts.join("");
}

function mapHotTopic(value: unknown): TimelineItemV1 | undefined {
  const entry = asObject(value);
  if (!entry) return undefined;
  const id = text(entry.re_id).trim();
  const title = text(entry.mul_name).trim();
  if (!id || !title) return undefined;
  const info = asObject(entry.topic_info) ?? {};
  const createdAt = isoFromEpoch(entry.create_time) ?? new Date().toISOString();
  const picture = text(info.head_pic);
  return {
    type: "feed",
    feed: {
      url:
        "https://tieba.baidu.com/mo/q/hotMessage?topic_id=" +
        encodeURIComponent(id) +
        "&topic_name=" +
        encodeURIComponent(title),
      createdAt,
      source: { name: "贴吧热议" },
      title,
      description: {
        format: "plain",
        value: text(entry.share_sub_title) || text(info.topic_desc),
      },
      media: picture
        ? { id: "hot-" + id, type: "image", url: normalizeUrl(picture) }
        : undefined,
    },
  };
}

function mapThreadDetail(
  floor: ThreadFloor,
  tid: string,
  context: PluginInvocationContextV1,
): PostV1 {
  const title = floor.title
    ? "<b>" + escapeHtml(floor.title) + "</b><br/>"
    : "";
  return {
    key: { id: "t" + tid, host: accountHost(context) },
    author: floorAuthor(floor, context),
    createdAt: parseTiebaTime(floor.timeText) ?? new Date().toISOString(),
    content: { format: "html", value: title + floor.contentHtml || " " },
    media: floorMedia(floor),
    detailType: "post",
    url: threadUrl(tid),
  };
}

function mapFloor(
  floor: ThreadFloor,
  tid: string,
  context: PluginInvocationContextV1,
  internal: boolean,
): PostV1 {
  return {
    key: { id: "p" + tid + "_" + floor.pid, host: accountHost(context) },
    author: floorAuthor(floor, context),
    createdAt: parseTiebaTime(floor.timeText) ?? new Date().toISOString(),
    content: { format: "html", value: floor.contentHtml || " " },
    media: floorMedia(floor),
    detailType: internal ? "post" : "link",
    url: threadUrl(tid) + "?pid=" + encodeURIComponent(floor.pid),
  };
}

function floorAuthor(
  floor: ThreadFloor,
  context: PluginInvocationContextV1,
): ProfileV1 {
  const id = floor.userName || floor.pid;
  return {
    key: { id, host: accountHost(context) },
    handle: floor.userName || id,
    displayName: floor.displayName || floor.userName || id,
    avatarUrl: avatarUrl(floor.portrait),
  };
}

function floorMedia(floor: ThreadFloor): MediaV1[] | undefined {
  const urls: string[] = [];
  const pattern = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(floor.contentHtml)) !== null) {
    const url = normalizeUrl(decodeEntities(match[1]));
    if (!/^https:\/\/[^/]+\.(?:baidu|bdimg|bdstatic|bdurl|hiphotos)\.com\//i.test(url)) continue;
    if (/\/tb\/editor\//i.test(url)) continue;
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= 9) break;
  }
  return urls.length
    ? urls.map((url, index) => ({
        id: floor.pid + "-" + String(index),
        type: "image" as const,
        url,
      }))
    : undefined;
}

function forumDescriptors(value: unknown): TimelineDescriptorV1[] {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const descriptors: TimelineDescriptorV1[] = [];
  for (const entry of list) {
    const forum = asObject(entry);
    if (!forum) continue;
    const name = text(forum.forum_name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    descriptors.push({
      id: "forum:" + name,
      title: { value: name },
      icon: "List",
      parameters: { kw: name },
    });
  }
  return descriptors;
}

function parseThreadPage(html: string): ThreadFloor[] {
  const floors: ThreadFloor[] = [];
  const pattern = /<li\b([^>]*\bj_post_list_item\b[^>]*)>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1];
    const body = match[2];
    const rawInfo = /\bdata-info="([^"]*)"/.exec(attributes);
    if (!rawInfo) continue;
    let info: JsonObject;
    try {
      const parsed: unknown = JSON.parse(decodeEntities(rawInfo[1]));
      const object = asObject(parsed);
      if (!object) continue;
      info = object;
    } catch {
      continue;
    }
    const pid = text(info.pid).trim();
    if (!pid) continue;
    const tidMatch = /\bdata-tid="(\d+)"/.exec(attributes);
    const contentHtml = extractDivByClass(body, "content");
    const titleHtml = extractDivByClass(body, "post_title_embed");
    const timeMatch = /<span class="list_item_time">([^<]*)<\/span>/.exec(body);
    floors.push({
      tid: tidMatch ? tidMatch[1] : "",
      pid,
      floor: numberOr(info.floor_num, 1),
      userName: text(info.un).trim(),
      displayName: text(info.name_show).trim(),
      portrait: text(info.portrait).trim(),
      contentHtml: normalizeContentHtml(contentHtml),
      title: stripTags(titleHtml).trim(),
      timeText: timeMatch ? timeMatch[1].trim() : "",
    });
  }
  return floors;
}

function normalizeContentHtml(html: string): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  // 懒加载图：<div class="pb_img_item" data-url='...'> 与 <img data-url="...">
  out = out.replace(
    /<div\b[^>]*\bclass="[^"]*pb_img_item[^"]*"[^>]*\bdata-url=(?:"([^"]*)"|'([^']*)')[^>]*>\s*<\/div>/gi,
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined) =>
      '<img src="' + (doubleQuoted ?? singleQuoted ?? "") + '"/>',
  );
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const lazy = /\bdata-url=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!lazy) return tag;
    const url = lazy[1] ?? lazy[2] ?? "";
    if (!url) return tag;
    const alt = /\balt=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const altText = alt ? alt[1] ?? alt[2] ?? "" : "";
    return '<img src="' + url + '" alt="' + altText + '"/>';
  });
  out = out.replace(/https?:\/\/[^"'\s<>]+/gi, (url) => normalizeUrl(url));
  return out.trim();
}

function extractDivByClass(html: string, className: string): string {
  const open = new RegExp(
    '<div\\b[^>]*\\bclass="[^"]*\\b' + className + '\\b[^"]*"[^>]*>',
    "i",
  );
  const match = open.exec(html);
  if (!match) return "";
  const start = match.index + match[0].length;
  let depth = 1;
  const tagPattern = /<div\b| <\/div>|<\/div>/gi;
  tagPattern.lastIndex = start;
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(html)) !== null) {
    if (tag[0].indexOf("/") !== -1) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(start, tag.index);
  }
  return html.slice(start);
}

function normalizeUrl(value: string): string {
  let url = decodeEntities(value).trim();
  if (url.startsWith("//")) url = "https:" + url;
  url = url.replace(/^http:\/\//i, "https://");
  url = url.replace(
    /^https:\/\/[a-z0-9-]+\.hiphotos\.baidu\.com\//i,
    "https://imgsrc.baidu.com/",
  );
  url = url.replace(/^https:\/\/tb\.himg\.baidu\.com\//i, "https://himg.bdimg.com/");
  return url;
}

function avatarUrl(portrait: string): string | undefined {
  const value = portrait.trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return normalizeUrl(value);
  return "https://himg.bdimg.com/sys/portrait/item/" + value;
}

function threadUrl(tid: string): string {
  return "https://tieba.baidu.com/p/" + tid;
}

function threadPagePath(tid: string, page: number): string {
  // 贴吧移动端用 pn 表示楼层偏移，不是页码：第 1 页给 1 楼起，之后每页前进 30 层。
  const offset = page <= 1 ? 1 : 1 + (page - 1) * 30;
  return "/mo/q/m?kz=" + tid + "&pn=" + String(offset);
}

function threadIdOf(id: string): string | null {
  if (id.startsWith("t")) {
    const tid = id.slice(1);
    return /^\d+$/.test(tid) ? tid : null;
  }
  const match = /^p(\d+)_\d+$/.exec(id);
  return match ? match[1] : null;
}

async function requestData(
  path: string,
  context: PluginInvocationContextV1,
): Promise<JsonObject> {
  const cookies = await readCookies();
  const response = await hostRequest({
    url: context.origin + path,
    cookies,
    headers: JSON_HEADERS,
  });
  if (response.status === 403) {
    fail("AuthenticationRequired", "百度安全验证拦截了请求，请在浏览器中重新登录贴吧");
  }
  if (response.status < 200 || response.status >= 300) {
    fail("Remote", "The website returned an error");
  }
  const root = parseJsonObject(response.body);
  if (!root) fail("InvalidResponse", "The website did not return JSON");
  const code = root.no ?? root.errno;
  if (code !== undefined && Number(code) !== 0) {
    const message = text(root.error) || text(root.errmsg);
    if (/logined|登录/i.test(message)) {
      fail("AuthenticationRequired", "Sign in again");
    }
    fail("Remote", message || "The website rejected the request");
  }
  const data = asObject(root.data);
  if (!data) fail("InvalidResponse", "The website response was incomplete");
  return data;
}

async function requestHtml(
  path: string,
  context: PluginInvocationContextV1,
): Promise<string> {
  const cookies = await readCookies();
  const response = await hostRequest({
    url: context.origin + path,
    cookies,
    headers: HTML_HEADERS,
  });
  if (response.status === 403) {
    fail("AuthenticationRequired", "百度安全验证拦截了请求，请在浏览器中重新登录贴吧");
  }
  if (response.status < 200 || response.status >= 300) {
    fail("Remote", "The website returned an error");
  }
  return response.body;
}

async function readCookies(): Promise<TiebaCookie[]> {
  const value = await flare.credential.read();
  const stored = asObject(value);
  const list = stored && Array.isArray(stored.cookies) ? stored.cookies : [];
  const cookies: TiebaCookie[] = [];
  for (const entry of list) {
    const cookie = asObject(entry);
    if (!cookie) continue;
    const name = text(cookie.name);
    const content = text(cookie.value);
    if (name && content) cookies.push({ name, value: content });
  }
  return cookies;
}

async function hostRequest(request: HttpRequestV1): Promise<HttpResponseV1> {
  try {
    return await flare.http.request(request);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (code === "host.unavailable") {
        fail("Network", "The request could not be completed");
      }
    }
    throw error;
  }
}

function parseJsonObject(body: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function hasCookie(cookies: TiebaCookie[], name: string): boolean {
  return cookies.some((cookie) => cookie.name === name && cookie.value.length > 0);
}

function isLoggedIn(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return numberOrUndefined(value) ?? fallback;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isoFromEpoch(value: unknown): string | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return new Date(parsed * 1000).toISOString();
}

function parseTiebaTime(value: string): string | undefined {
  const source = value.trim();
  if (!source) return undefined;
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  let match = /^今天\s*(\d{1,2}):(\d{2})$/.exec(source);
  if (match) {
    return isoShanghai(year, month, day, Number(match[1]), Number(match[2]));
  }
  match = /^昨天\s*(\d{1,2}):(\d{2})$/.exec(source);
  if (match) {
    const previous = new Date(Date.UTC(year, month - 1, day));
    previous.setUTCDate(previous.getUTCDate() - 1);
    return isoShanghai(
      previous.getUTCFullYear(),
      previous.getUTCMonth() + 1,
      previous.getUTCDate(),
      Number(match[1]),
      Number(match[2]),
    );
  }
  match = /^(\d{1,2}):(\d{2})$/.exec(source);
  if (match) {
    return isoShanghai(year, month, day, Number(match[1]), Number(match[2]));
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(source);
  if (match) {
    return isoShanghai(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
    );
  }
  match = /^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(source);
  if (match) {
    return isoShanghai(
      year,
      Number(match[1]),
      Number(match[2]),
      Number(match[3] ?? 0),
      Number(match[4] ?? 0),
    );
  }
  return undefined;
}

function isoShanghai(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return (
    String(year) +
    "-" +
    pad2(month) +
    "-" +
    pad2(day) +
    "T" +
    pad2(hour) +
    ":" +
    pad2(minute) +
    ":00+08:00"
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, "")).replace(/\u00a0/g, " ");
}

function accountHost(context: PluginInvocationContextV1): string {
  return context.origin.slice("https://".length);
}

function fail(code: PluginErrorCodeV1, message: string): never {
  throw flare.error({ code, message: { value: message } });
}
