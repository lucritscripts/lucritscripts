// Real URLs.
//
// The site used to be one address. Everything — a script, a profile, the
// dashboard — was an overlay drawn over "/", which meant none of it could be
// linked to, shared, bookmarked, or reloaded. Sending someone a script meant
// sending them the home page and telling them what to click.
//
// This module is the fix, and it is deliberately small. It does not render
// anything and it does not own any state beyond "which route is on screen".
// It turns a pathname into a call, and a call back into a pathname:
//
//   /                              home
//   /creations/<creator>/<slug>    one script
//   /creators/<creator>            someone's public profile
//   /dashboard/<you>               your own dashboard
//   /executors                     the executor listing
//   /executors/<slug>              one executor
//   /admin                         the owner's panel
//
// Two decisions worth keeping.
//
// 1. The creator's name is in the script URL even though the slug alone would
//    find it. It is there for the person reading the link — "who wrote this"
//    is the thing you want to see before you click — and the page corrects the
//    name if it is wrong rather than 404ing, so a link survives a rename.
//
// 2. The Worker has to agree about this list. Every path here is served the
//    app shell by APP_ROUTES in _worker.js; a route added on one side and not
//    the other is a 404 on refresh, which is exactly the bug real URLs were
//    supposed to fix.

const enc = (s) => encodeURIComponent(String(s ?? "").trim());

/** The half of a script id that belongs in an address bar. */
export function slugFor(script) {
  if (!script) return "";
  return String(script.slug || String(script.id || "").replace(/^s_/, ""));
}

export function pathForScript(script) {
  const slug = slugFor(script);
  if (!slug) return "/";
  return `/creations/${enc(script.author || "unknown")}/${enc(slug)}`;
}

export function pathForCreator(name) {
  return name ? `/creators/${enc(name)}` : "/";
}

export function pathForDashboard(name) {
  return name ? `/dashboard/${enc(name)}` : "/dashboard";
}

/**
 * An executor's own address, or the listing when there is no executor.
 *
 * Executors carry their slug the way scripts do, and for the same reason: the
 * id is `x_<slug>` in the database and the `x_` prefix is an implementation
 * detail nobody should have to type or paste.
 */
export function pathForExecutor(x) {
  const slug = x && (x.slug || String(x.id || "").replace(/^x_/, ""));
  return slug ? `/executors/${enc(slug)}` : "/executors";
}

/**
 * Reads a pathname into a route.
 *
 * Segments are decoded here, once, so nothing downstream has to remember to.
 * A malformed escape (someone hand-typing a stray %) decodes to itself rather
 * than throwing and taking the whole page down with it.
 */
function decode(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

export function parse(pathname = location.pathname) {
  const parts = String(pathname).split("/").filter(Boolean).map(decode);

  if (!parts.length) return { name: "home" };
  if (parts.length === 1 && parts[0] === "admin") return { name: "admin" };

  if (parts[0] === "creators" && parts.length === 2)
    return { name: "creator", creator: parts[1] };

  if (parts[0] === "creations" && parts.length === 3)
    return { name: "creation", creator: parts[1], slug: parts[2] };

  if (parts[0] === "dashboard" && parts.length <= 2)
    return { name: "dashboard", creator: parts[1] || "" };

  // Two routes, one prefix. The listing and a single executor are different
  // enough on screen to be different handlers, but they share a URL root so
  // that "/executors" is a place you can go rather than only a namespace.
  if (parts[0] === "executors" && parts.length === 1) return { name: "executors" };
  if (parts[0] === "executors" && parts.length === 2)
    return { name: "executor", slug: parts[1] };

  return { name: "unknown", pathname };
}

/**
 * The page title, which is the other half of a shareable link.
 *
 * A URL that can be pasted into a chat is only useful if the tab it opens says
 * what it is. Everything used to be "Lucrit Script" no matter where you were.
 */
export function setTitle(text) {
  document.title = text ? `${text} · Lucrit Script` : "Lucrit Script — 3D Roblox script library";
}

/**
 * @param handlers  one function per route name. Each is called with the parsed
 *                  route and may be async; the router does not wait on them.
 */
export function createRouter(handlers = {}) {
  // What the address bar currently claims is on screen. Kept so that closing
  // an overlay can tell "we are still on that route, put the URL back" apart
  // from "something else already moved us on".
  let showing = "home";

  function resolve(route, { silent = false } = {}) {
    showing = route.name;
    const fn = handlers[route.name] || handlers.unknown;
    if (!fn) return;
    try { fn(route, { silent }); } catch (err) { console.warn("[lucrit] route failed:", err); }
  }

  /** Move to a path AND draw it. For links and programmatic navigation. */
  function go(path, { replace = false } = {}) {
    if (path !== location.pathname + location.search) {
      history[replace ? "replaceState" : "pushState"](null, "", path);
    }
    resolve(parse(path));
  }

  return {
    get route() { return parse(); },
    get showing() { return showing; },

    /** What a path resolves to, without going there. */
    nameFor: (path) => parse(path).name,

    /** Resolve whatever URL the page was opened at. */
    start() { resolve(parse()); },

    go,

    /**
     * Point the address bar at a path WITHOUT drawing it.
     *
     * For the case where an overlay is already opening — a card click has the
     * script in hand and does not need it refetched by the router. Skipping
     * the redraw is not an optimisation here, it is correctness: resolving
     * would open the sheet a second time on top of itself.
     */
    setPath(path, { replace = false } = {}) {
      showing = parse(path).name;
      if (path === location.pathname + location.search) return;
      history[replace ? "replaceState" : "pushState"](null, "", path);
    },

    /**
     * Correct the current URL in place — a creator renamed, a slug reached by
     * the wrong author name. No history entry: the visitor did not navigate,
     * the address bar was simply wrong.
     */
    correct(path) {
      if (path === location.pathname) return;
      history.replaceState(null, "", path);
    },

    /**
     * An overlay closed. Put the address bar back on the home page, but only
     * if it still points at the thing that just closed.
     */
    leave(routeName) {
      if (showing !== routeName) return;
      showing = "home";
      setTitle("");
      if (location.pathname !== "/") history.replaceState(null, "", "/");
    },

    /** Wire up back/forward and in-app links. Call once. */
    listen() {
      addEventListener("popstate", () => resolve(parse()));

      // One delegated listener for every internal link on the site. Anchors
      // stay real anchors — middle-click, ctrl-click and "copy link address"
      // all keep working, which is the point of using them over buttons.
      //
      // Capture phase, and it stops the event dead. The author's name is a
      // link INSIDE a card, and the card's own handler opens the script: in
      // the bubble phase the card wins first, so clicking "@Kiwi" opened the
      // script and the profile, one on top of the other. Taking the event
      // before it reaches the card is what makes a link inside a clickable
      // thing mean the link.
      document.addEventListener("click", (e) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

        const a = e.target.closest("a[href]");
        if (!a || a.target === "_blank" || a.hasAttribute("download")) return;

        const href = a.getAttribute("href");
        if (!href || !href.startsWith("/") || href.startsWith("//")) return;
        if (parse(href).name === "unknown") return;   // a real file, let it load

        e.preventDefault();
        e.stopPropagation();
        go(href);
      }, true);
    },
  };
}
