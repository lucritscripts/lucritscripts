// Firebase bootstrap.
//
// The config below is PUBLIC on purpose. A Firebase web apiKey is not a
// secret — it identifies the project, it does not authorise anything. Google
// ships it in client code by design; what actually protects your data is
// Firestore security rules plus Auth. (The NVIDIA and LootLabs keys are the
// opposite: those are real secrets and live only in Cloud Functions.)
//
// The SDK loads from Google's CDN. If it cannot load — offline, blocked, or
// the project is not configured — `firebaseReady` resolves to null and the
// site falls back to browser-local accounts. Nothing breaks either way.

const SDK = "https://www.gstatic.com/firebasejs/11.1.0";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAHs0dG8DX05TtUcFURXgGVe-ZqLdh9Sbc",
  authDomain: "lucrit-script.firebaseapp.com",
  projectId: "lucrit-script",
  storageBucket: "lucrit-script.firebasestorage.app",
  messagingSenderId: "584067983078",
  appId: "1:584067983078:web:bc152a332044f67e1d7d27",
};

/** Set false to force the local fallback without deleting the config. */
export const USE_FIREBASE = true;

async function connect() {
  if (!USE_FIREBASE || !FIREBASE_CONFIG.apiKey) return null;

  const [{ initializeApp }, auth, store] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);

  const app = initializeApp(FIREBASE_CONFIG);

  return {
    app,
    auth: auth.getAuth(app),
    db: store.getFirestore(app),
    // Re-exported so callers need only this module, and so the SDK version
    // is pinned in exactly one place.
    fns: { ...auth, ...store },
  };
}

/** Resolves to the live SDK handles, or null when Firebase is unavailable. */
export const firebaseReady = connect().catch((err) => {
  console.warn("[lucrit] Firebase unavailable, using local accounts:", err?.message || err);
  return null;
});
