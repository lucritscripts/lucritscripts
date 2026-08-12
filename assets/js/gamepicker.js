// Searchable Roblox game picker.
//
// Roblox's search API refuses browser requests (no CORS), so a static site
// cannot list every experience live. This ships a curated set of the games
// people actually publish scripts for, filtered as you type, and always
// accepts a game it doesn't know.
//
// When the Cloudflare Worker exists, `searchRemote()` becomes a fetch to it
// and the local list turns into the offline fallback — nothing else changes.

export const POPULAR_GAMES = [
  // simulators & incremental
  "Grow a Garden", "Pet Simulator 99", "Pet Simulator X", "Bee Swarm Simulator",
  "Mining Simulator 2", "Anime Fighting Simulator", "Muscle Legends", "Ninja Legends",
  "Saber Simulator", "Strongman Simulator", "Clicker Simulator", "Fishing Simulator",
  "Sols RNG", "Fisch", "Steal a Brainrot", "Blox Fruits",
  // roleplay & town
  "Brookhaven RP", "Welcome to Bloxburg", "Adopt Me!", "MeepCity", "Royale High",
  "Berry Avenue RP", "Livetopia", "Bloxburg", "Greenville", "Emergency Response: Liberty County",
  "Da Hood", "Mad City", "Jailbreak", "Prison Life", "Ultimate Driving",
  // fighting & battlegrounds
  "The Strongest Battlegrounds", "Blade Ball", "Slap Battles", "Combat Warriors",
  "Untitled Boxing Game", "Anime Last Stand", "Anime Vanguards", "Blue Lock Rivals",
  "Project Slayers", "Demonfall", "Shindo Life", "King Legacy", "Grand Piece Online",
  "Deepwoken", "Rogue Lineage", "Criminality", "Arcane Odyssey",
  // shooters
  "Phantom Forces", "Arsenal", "Big Paintball", "Bad Business", "Frontlines",
  "Counter Blox", "Energy Assault", "Rivals", "Roblox Bedwars", "Zombie Attack",
  // horror & survival
  "Doors", "Rainbow Friends", "Piggy", "The Mimic", "Apeirophobia", "Identity Fraud",
  "Flee the Facility", "Evade", "Break In", "Dead Rails", "99 Nights in the Forest",
  "Natural Disaster Survival", "Survive the Killer", "Murder Mystery 2",
  // tycoons
  "Theme Park Tycoon 2", "Restaurant Tycoon 2", "Retail Tycoon 2", "My Restaurant",
  "Lumber Tycoon 2", "Car Dealership Tycoon", "Work at a Pizza Place", "Miner's Haven",
  "Two Player Tycoon", "Airport Tycoon",
  // tower defense
  "Tower Defense Simulator", "All Star Tower Defense", "Tower Battles",
  "Anime Adventures", "Toilet Tower Defense", "Critical Legends",
  // obby & platforming
  "Tower of Hell", "Obby Creator", "Speed Run 4", "Steep Steps", "Rainbow Obby",
  "Escape Running Head", "Mega Easy Obby", "Parkour",
  // rpg & dungeon
  "Dungeon Quest", "World Zero", "Vesteria", "Swordburst 2", "Islands",
  "Adventure Story", "Blox Fruits: Second Sea",
  // sports & vehicles
  "Football Fusion 2", "Ultimate Football", "Basketball Legends", "Volleyball Legends",
  "Driving Empire", "Vehicle Legends", "Jailbreak Racing", "Car Crushers 2",
  "Midnight Racing: Tokyo", "Pacifico",
  // minigames & social
  "Epic Minigames", "Super Golf", "Bedwars Practice", "Blox Cards", "Catalog Avatar Creator",
  "Club Roblox", "Starving Artists", "Build A Boat For Treasure", "Nico's Nextbots",
  "Rate My Avatar", "Free Admin", "Bloxy Bingo",
  // building & sandbox
  "Roblox Studio Sandbox", "Plane Crazy", "Build a Base", "Lumber Tycoon",
  "Welcome to Farmtown 2", "Fantastic Frontier",
];

/** Swapped for a Worker call once the proxy exists. */
async function searchRemote() { return null; }

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function rank(query, list) {
  const q = norm(query);
  if (!q) return list.slice(0, 40);

  return list
    .map((name) => {
      const n = norm(name);
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 70;
      else if (n.includes(q)) score = 45;
      else if (q.split(" ").every((w) => n.includes(w))) score = 25;
      return { name, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, 40)
    .map((r) => r.name);
}

/**
 * Builds the picker. Writes the chosen game into a hidden input so it submits
 * with the surrounding form exactly like the old text field did.
 */
export function createGamePicker({ name = "game", placeholder = "Search Roblox games..." } = {}) {
  const root = document.createElement("div");
  root.className = "gpick";
  root.innerHTML = `
    <input type="hidden" name="${name}">
    <div class="gpick__field">
      <svg class="gpick__icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>
      </svg>
      <input class="gpick__input" type="text" role="combobox" autocomplete="off"
             aria-expanded="false" aria-controls="gpick-list" aria-autocomplete="list"
             placeholder="${placeholder}">
      <button type="button" class="gpick__clear" aria-label="Clear" hidden>&times;</button>
      <svg class="gpick__caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <ul class="gpick__list" id="gpick-list" role="listbox" hidden></ul>`;

  const hidden = root.querySelector('input[type="hidden"]');
  const input = root.querySelector(".gpick__input");
  const list = root.querySelector(".gpick__list");
  const clear = root.querySelector(".gpick__clear");

  let options = [];
  let active = -1;

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  }

  function choose(value) {
    hidden.value = value;
    input.value = value;
    clear.hidden = !value;
    close();
    root.dispatchEvent(new CustomEvent("gamechange", { detail: value, bubbles: true }));
  }

  function paint(items, typed) {
    options = items.slice();
    const custom = typed && !items.some((i) => norm(i) === norm(typed));

    list.innerHTML = [
      ...items.map((nm, i) => `
        <li role="option" id="gpick-o${i}" data-value="${nm.replace(/"/g, "&quot;")}"
            class="gpick__opt" aria-selected="false">
          <span class="gpick__dot" aria-hidden="true"></span>${nm}
        </li>`),
      custom ? `<li role="option" data-value="${typed.replace(/"/g, "&quot;")}"
          class="gpick__opt gpick__opt--custom" aria-selected="false">Use “<b>${typed.replace(/</g, "&lt;")}</b>” — not in the list</li>` : "",
      !items.length && !custom ? `<li class="gpick__none">Start typing a game name</li>` : "",
    ].join("");

    if (custom) options.push(typed);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function highlight(next) {
    const nodes = Array.from(list.querySelectorAll(".gpick__opt"));
    if (!nodes.length) return;
    active = (next + nodes.length) % nodes.length;
    nodes.forEach((n, i) => {
      const on = i === active;
      n.classList.toggle("is-active", on);
      n.setAttribute("aria-selected", on ? "true" : "false");
      if (on) n.scrollIntoView({ block: "nearest" });
    });
  }

  async function refresh() {
    const typed = input.value.trim();
    const remote = await searchRemote(typed);
    paint(remote || rank(typed, POPULAR_GAMES), typed);
  }

  input.addEventListener("focus", refresh);
  input.addEventListener("input", () => { hidden.value = ""; clear.hidden = !input.value; refresh(); });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) refresh(); else highlight(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); }
    else if (e.key === "Enter") {
      const nodes = Array.from(list.querySelectorAll(".gpick__opt"));
      if (!list.hidden && nodes[active]) { e.preventDefault(); choose(nodes[active].dataset.value); }
      else if (input.value.trim()) { e.preventDefault(); choose(input.value.trim()); }
    } else if (e.key === "Escape") { close(); }
  });

  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".gpick__opt");
    if (opt) { e.preventDefault(); choose(opt.dataset.value); }
  });

  clear.addEventListener("click", () => { choose(""); input.focus(); });

  input.addEventListener("blur", () => {
    // A typed-but-unconfirmed name should still count as the answer.
    setTimeout(() => {
      if (!list.hidden) close();
      if (!hidden.value && input.value.trim()) choose(input.value.trim());
    }, 120);
  });

  document.addEventListener("click", (e) => { if (!root.contains(e.target)) close(); });

  return {
    node: root,
    get value() { return hidden.value; },
    set(value) { choose(value || ""); },
    reset() { hidden.value = ""; input.value = ""; clear.hidden = true; close(); },
  };
}
