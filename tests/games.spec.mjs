// The game list behind the publish form's picker and the game library.
// Updated 18 Oct 2026 with the games on the live most-played/trending charts.
import { counter } from "./harness.mjs";
import { POPULAR_GAMES } from "../assets/js/gamepicker.js";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { allGames, gameId } = await import("../assets/js/games.js");
const { check, done } = counter();

const ids = POPULAR_GAMES.map(gameId);
console.log("Game list");
check("no game listed twice (same id)", new Set(ids).size === ids.length,
  ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
check("200+ games to pick from", POPULAR_GAMES.length >= 200, String(POPULAR_GAMES.length));
for (const g of ["Steal An Egg", "Dress To Impress", "Jujutsu Shenanigans", "Forsaken", "Fish It!",
  "Dandy's World", "Grow a Garden 2", "Violence District", "Anime Dice", "Ride A Pet", "Slayers 2",
  "Bubble Gum Simulator INFINITY", "+1 Speed Keyboard Escape"]) {
  check(`has ${g}`, POPULAR_GAMES.includes(g));
}
check("the newest trending games come first in the picker's default list",
  POPULAR_GAMES.indexOf("Steal An Egg") < POPULAR_GAMES.indexOf("Pet Simulator 99"));
check("older favourites are still there", ["Blox Fruits", "Da Hood", "Grow a Garden", "Brookhaven RP"].every((g) => POPULAR_GAMES.includes(g)));
const lib = allGames([]);
check("every listed game shows up in the game library", POPULAR_GAMES.every((n) => lib.some((g) => g.id === gameId(n))));
check("'+1' and '!' names get clean ids", gameId("+1 Speed Keyboard Escape") === "1-speed-keyboard-escape" && gameId("Fish It!") === "fish-it");
done();
