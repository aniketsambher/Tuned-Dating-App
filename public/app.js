// Tuned web UI: a small single-page app on top of the JSON API.
// Views are chosen by the URL hash (#discover, #matches, #profile). No build step, no dependencies.
"use strict";

(() => {
  const TOKEN_KEY = "tuned.token";
  const ROUTES = ["discover", "matches", "profile"];

  /** localStorage can throw (private mode, blocked storage); the app still works, just without remembering you. */
  const storage = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
  };

  const state = {
    token: storage.get(TOKEN_KEY),
    me: null,
    queue: [], // discover candidates not yet acted on
    queueLoaded: false,
    busy: false,
    notice: null, // shown once on the next render
    loginError: null,
  };

  const view = document.getElementById("view");
  const nav = document.getElementById("nav");
  const modalRoot = document.getElementById("modal-root");

  // ---------- small helpers ----------

  /** Builds DOM nodes. Text children are always inserted as text, never parsed as HTML. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "vars") for (const [name, v] of Object.entries(value)) el.style.setProperty(name, String(v));
      else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function mount(...nodes) {
    view.replaceChildren(...nodes);
  }

  function toast(message, kind = "info") {
    const el = h("div", { class: `toast toast-${kind}` }, message);
    document.getElementById("toasts").append(el);
    setTimeout(() => el.classList.add("toast-out"), 3800);
    setTimeout(() => el.remove(), 4300);
  }

  const percent = (score) => Math.round(score * 100);

  function hueFor(text) {
    let hash = 0;
    for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return hash % 360;
  }

  function initials(name) {
    const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
  }

  function avatar(user, size = "md") {
    if (user.avatarUrl) {
      return h("img", { class: `avatar avatar-${size}`, src: user.avatarUrl, alt: "" });
    }
    return h(
      "div",
      { class: `avatar avatar-${size}`, vars: { "--hue": hueFor(user.displayName) }, "aria-hidden": "true" },
      initials(user.displayName),
    );
  }

  function scoreRing(score, size = "md") {
    const p = percent(score);
    return h(
      "div",
      { class: `ring ring-${size}`, vars: { "--p": p }, role: "img", "aria-label": `${p}% taste match` },
      h("span", { class: "ring-value" }, `${p}%`),
    );
  }

  function chips(items, kind = "") {
    return h("ul", { class: `chips ${kind}` }, items.map((text) => h("li", { class: "chip" }, text)));
  }

  const relativeTime = (() => {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    const units = [
      ["year", 31536000],
      ["month", 2592000],
      ["week", 604800],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ];
    return (iso) => {
      const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
      for (const [unit, s] of units) if (Math.abs(seconds) >= s) return rtf.format(Math.round(seconds / s), unit);
      return "just now";
    };
  })();

  // ---------- API ----------

  async function api(path, { method = "GET", body } = {}) {
    const headers = { Authorization: `Bearer ${state.token}` };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Request failed (${res.status})`);
      err.code = data?.error?.code;
      err.status = res.status;
      if (res.status === 401 && err.code === "unauthorized") {
        logout("Your session ended. Log in again.");
      }
      throw err;
    }
    return data;
  }

  // ---------- session ----------

  /** After Spotify login the server redirects to /#token=... (or /#error=...). */
  function readLoginFragment() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("token")) {
      state.token = params.get("token");
      storage.set(TOKEN_KEY, state.token);
      if (params.get("tasteSynced") === "false") {
        state.notice = "You're in, but we couldn't read your Spotify artists yet. Try “Re-sync from Spotify” on your profile.";
      }
      history.replaceState(null, "", `${location.pathname}#discover`);
    } else if (params.has("error")) {
      state.loginError = params.get("message") || params.get("error");
      history.replaceState(null, "", location.pathname);
    }
  }

  function logout(message) {
    state.token = null;
    state.me = null;
    state.queue = [];
    state.queueLoaded = false;
    storage.set(TOKEN_KEY, null);
    closeModal();
    if (message) state.loginError = message;
    history.replaceState(null, "", location.pathname);
    render();
  }

  // ---------- views ----------

  function landingView() {
    return h(
      "section",
      { class: "landing" },
      h(
        "div",
        { class: "landing-copy" },
        h("p", { class: "eyebrow" }, "Dating, by what you actually listen to"),
        h("h1", null, "Meet people who share your ", h("em", null, "on repeat"), "."),
        h(
          "p",
          { class: "lede" },
          "Tuned reads your top artists from Spotify and ranks people by how much your listening overlaps, ",
          "weighted toward the artists you play most.",
        ),
        state.loginError && h("p", { class: "alert", role: "alert" }, state.loginError),
        h("a", { class: "button button-primary button-lg", href: "/auth/spotify/login" }, "Log in with Spotify"),
        h("p", { class: "fineprint" }, "We only read your top artists and basic profile. Nothing is posted to Spotify."),
      ),
      h(
        "ol",
        { class: "steps" },
        step("1", "Connect Spotify", "We pull your top 50 artists."),
        step("2", "Discover", "People are ranked by a weighted taste-overlap score."),
        step("3", "Match", "Like each other and it's a match."),
      ),
    );
  }

  function step(n, title, text) {
    return h("li", { class: "step" }, h("span", { class: "step-n" }, n), h("div", null, h("strong", null, title), h("p", null, text)));
  }

  async function discoverView() {
    if (!state.queueLoaded) {
      mount(h("p", { class: "loading" }, "Finding people with your taste…"));
      try {
        const { candidates } = await api("/discover?limit=20");
        state.queue = candidates;
        state.queueLoaded = true;
      } catch (err) {
        if (err.code === "taste_not_synced") return mount(needsSyncView());
        if (err.status === 401) return;
        return mount(errorView(err));
      }
    }
    if (currentRoute() !== "discover") return;

    const next = state.queue[0];
    if (!next) {
      return mount(
        h(
          "section",
          { class: "empty" },
          h("h2", null, "You're all caught up"),
          h("p", null, "No one new shares your taste right now. Check back after more people join, or refresh your artists."),
          h(
            "div",
            { class: "row" },
            h("a", { class: "button", href: "#matches" }, "See your matches"),
            h("button", { class: "button button-ghost", type: "button", onClick: refreshQueue }, "Look again"),
          ),
        ),
      );
    }

    const { user, compatibility: c } = next;
    const remaining = state.queue.length - 1;
    mount(
      h(
        "section",
        { class: "discover" },
        h(
          "article",
          { class: "card profile-card", "aria-labelledby": "candidate-name" },
          h(
            "header",
            { class: "card-head" },
            avatar(user, "lg"),
            h("div", { class: "card-title" }, h("h2", { id: "candidate-name" }, user.displayName), user.bio && h("p", { class: "bio" }, user.bio)),
            scoreRing(c.score, "lg"),
          ),
          h(
            "div",
            { class: "card-body" },
            c.sharedArtists.length > 0 &&
              h("div", null, h("h3", null, "You both listen to"), chips(c.sharedArtists.map((a) => a.name), "chips-artists")),
            c.sharedGenres.length > 0 && h("div", null, h("h3", null, "Shared genres"), chips(c.sharedGenres)),
            h(
              "dl",
              { class: "breakdown" },
              h("div", null, h("dt", null, "Artist overlap"), h("dd", null, `${percent(c.artistScore)}%`)),
              c.sharedGenres.length > 0 && h("div", null, h("dt", null, "Genre overlap"), h("dd", null, `${percent(c.genreScore)}%`)),
            ),
          ),
          h(
            "footer",
            { class: "card-actions" },
            h("button", { class: "button button-pass", type: "button", onClick: () => decide("pass"), "aria-keyshortcuts": "ArrowLeft" }, "Pass"),
            h("button", { class: "button button-like", type: "button", onClick: () => decide("like"), "aria-keyshortcuts": "ArrowRight" }, "Like"),
          ),
        ),
        h(
          "p",
          { class: "hint" },
          remaining > 0 ? `${remaining} more ${remaining === 1 ? "person" : "people"} in your queue · ` : "",
          h("kbd", null, "←"),
          " pass · ",
          h("kbd", null, "→"),
          " like",
        ),
      ),
    );
  }

  async function refreshQueue() {
    state.queueLoaded = false;
    await render();
  }

  async function decide(kind) {
    const next = state.queue[0];
    if (!next || state.busy) return;
    state.busy = true;
    view.querySelectorAll(".card-actions button").forEach((b) => (b.disabled = true));
    try {
      if (kind === "like") {
        const result = await api("/likes", { method: "POST", body: { userId: next.user.id } });
        if (result.matched) showMatchModal(result.match);
      } else {
        await api("/passes", { method: "POST", body: { userId: next.user.id } });
      }
      state.queue.shift();
      if (state.queue.length === 0) state.queueLoaded = false; // fetch more next time
    } catch (err) {
      if (err.status !== 401) toast(err.message, "error");
    } finally {
      state.busy = false;
    }
    if (currentRoute() === "discover") await discoverView();
  }

  async function matchesView() {
    mount(h("p", { class: "loading" }, "Loading your matches…"));
    let matches;
    try {
      ({ matches } = await api("/matches"));
    } catch (err) {
      if (err.status !== 401) mount(errorView(err));
      return;
    }
    if (currentRoute() !== "matches") return;

    if (matches.length === 0) {
      return mount(
        h(
          "section",
          { class: "empty" },
          h("h2", null, "No matches yet"),
          h("p", null, "When someone you like likes you back, they'll show up here."),
          h("a", { class: "button button-primary", href: "#discover" }, "Start discovering"),
        ),
      );
    }

    mount(
      h(
        "section",
        null,
        h("h1", { class: "page-title" }, "Matches ", h("span", { class: "count" }, String(matches.length))),
        h(
          "ul",
          { class: "match-list" },
          matches.map((m) =>
            h(
              "li",
              { class: "card match" },
              avatar(m.user, "md"),
              h(
                "div",
                { class: "match-body" },
                h("h2", null, m.user.displayName),
                h("p", { class: "muted" }, `Matched ${relativeTime(m.createdAt)}`),
                m.compatibility.sharedArtists.length > 0 &&
                  chips(m.compatibility.sharedArtists.map((a) => a.name), "chips-artists chips-sm"),
              ),
              scoreRing(m.compatibility.score, "sm"),
            ),
          ),
        ),
      ),
    );
  }

  async function profileView() {
    mount(h("p", { class: "loading" }, "Loading your profile…"));
    let data;
    try {
      data = await api("/me");
    } catch (err) {
      if (err.status !== 401) mount(errorView(err));
      return;
    }
    if (currentRoute() !== "profile") return;
    state.me = data.user;
    const { user, taste } = data;

    const nameInput = h("input", { id: "displayName", name: "displayName", value: user.displayName, maxlength: 50, required: true, autocomplete: "nickname" });
    const bioInput = h("textarea", { id: "bio", name: "bio", maxlength: 500, rows: 3, placeholder: "Say something about your music…" });
    bioInput.value = user.bio;
    const saveButton = h("button", { class: "button button-primary", type: "submit" }, "Save");

    async function save(event) {
      event.preventDefault();
      saveButton.disabled = true;
      try {
        await api("/me", { method: "PATCH", body: { displayName: nameInput.value, bio: bioInput.value } });
        toast("Profile saved", "success");
      } catch (err) {
        if (err.status !== 401) toast(err.message, "error");
      } finally {
        saveButton.disabled = false;
      }
    }

    const syncButton = h("button", { class: "button button-ghost", type: "button", onClick: sync }, "Re-sync from Spotify");
    async function sync() {
      syncButton.disabled = true;
      syncButton.textContent = "Syncing…";
      try {
        const result = await api("/me/sync", { method: "POST" });
        toast(`Synced ${result.artistCount} artists from Spotify`, "success");
        state.queueLoaded = false;
        await profileView();
      } catch (err) {
        if (err.status !== 401) toast(err.message, "error");
        syncButton.disabled = false;
        syncButton.textContent = "Re-sync from Spotify";
      }
    }

    mount(
      h(
        "section",
        { class: "profile" },
        h(
          "div",
          { class: "card" },
          h("header", { class: "card-head" }, avatar(user, "lg"), h("div", { class: "card-title" }, h("h1", null, user.displayName), h("p", { class: "muted" }, `Spotify: ${user.spotifyId}`))),
          h(
            "form",
            { class: "form", onSubmit: save },
            h("label", { for: "displayName" }, "Display name"),
            nameInput,
            h("label", { for: "bio" }, "Bio"),
            bioInput,
            h("div", { class: "row" }, saveButton),
          ),
        ),
        h(
          "div",
          { class: "card" },
          h("h2", null, "Your top artists"),
          taste.topArtists.length
            ? h("ol", { class: "top-artists" }, taste.topArtists.map((a) => h("li", null, a.name)))
            : h("p", { class: "muted" }, "No artists yet. Sync from Spotify to get matched."),
          h("h3", null, "Top genres"),
          taste.topGenres.length
            ? chips(taste.topGenres)
            : h("p", { class: "muted" }, "Spotify didn't share genre data for your artists, so matching uses artists only."),
          h(
            "div",
            { class: "row sync-row" },
            syncButton,
            h("span", { class: "muted" }, user.tasteSyncedAt ? `Last synced ${relativeTime(user.tasteSyncedAt)}` : "Never synced"),
          ),
        ),
      ),
    );
  }

  function needsSyncView() {
    return h(
      "section",
      { class: "empty" },
      h("h2", null, "Let's read your music first"),
      h("p", null, "We need your top artists from Spotify before we can find matches."),
      h("a", { class: "button button-primary", href: "#profile" }, "Go to profile and sync"),
    );
  }

  function errorView(err) {
    return h(
      "section",
      { class: "empty" },
      h("h2", null, "Something went wrong"),
      h("p", { class: "alert" }, err.message),
      h("button", { class: "button", type: "button", onClick: () => render() }, "Try again"),
    );
  }

  // ---------- match modal ----------

  function showMatchModal(match) {
    const close = () => closeModal();
    const dialog = h(
      "div",
      { class: "modal-backdrop", onClick: (e) => e.target === e.currentTarget && close() },
      h(
        "div",
        { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "match-title" },
        h("p", { class: "eyebrow" }, "Mutual like"),
        h("h2", { id: "match-title" }, "It's a match!"),
        h("div", { class: "match-pair" }, state.me ? avatar(state.me, "lg") : null, scoreRing(match.compatibility.score, "md"), avatar(match.user, "lg")),
        h("p", null, `You and ${match.user.displayName} liked each other.`),
        match.compatibility.sharedArtists.length > 0 && h("h3", null, "You both listen to"),
        match.compatibility.sharedArtists.length > 0 && chips(match.compatibility.sharedArtists.map((a) => a.name), "chips-artists chips-center"),
        h(
          "div",
          { class: "row row-center" },
          h("button", { class: "button button-primary", type: "button", onClick: close, autofocus: true }, "Keep discovering"),
          h("a", { class: "button button-ghost", href: "#matches", onClick: close }, "See matches"),
        ),
      ),
    );
    modalRoot.replaceChildren(dialog);
    dialog.querySelector("button")?.focus();
  }

  function closeModal() {
    modalRoot.replaceChildren();
  }

  // ---------- routing ----------

  function currentRoute() {
    const r = location.hash.slice(1);
    return ROUTES.includes(r) ? r : "discover";
  }

  async function render() {
    document.body.classList.toggle("signed-in", Boolean(state.token));
    nav.hidden = !state.token;

    if (!state.token) {
      document.title = "Tuned";
      mount(landingView());
      state.loginError = null;
      return;
    }

    const route = currentRoute();
    nav.querySelectorAll("a[data-route]").forEach((a) => a.setAttribute("aria-current", a.dataset.route === route ? "page" : "false"));
    document.title = `${route[0].toUpperCase()}${route.slice(1)} · Tuned`;

    if (!state.me) {
      // Fetched once for the match modal's avatar; failures here are non-fatal.
      api("/me").then((d) => (state.me = d.user)).catch(() => {});
    }

    if (state.notice) {
      toast(state.notice, "info");
      state.notice = null;
    }

    if (route === "discover") await discoverView();
    else if (route === "matches") await matchesView();
    else await profileView();
  }

  // ---------- wiring ----------

  document.getElementById("logout").addEventListener("click", () => logout());
  window.addEventListener("hashchange", () => {
    closeModal();
    readLoginFragment(); // in case a login redirect lands while the page is already open
    render();
    view.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeModal();
    if (!state.token || currentRoute() !== "discover" || modalRoot.childElementCount) return;
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowRight") decide("like");
    if (e.key === "ArrowLeft") decide("pass");
  });

  readLoginFragment();
  render();
})();
