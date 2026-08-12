// Entry point. Firebase discovers exported functions from this file.

import { initializeApp } from "firebase-admin/app";

initializeApp();

export { assistant } from "./assistant.js";
export { unlocks } from "./unlocks.js";
