import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  writeBatch
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js";

export const ADMIN_EMAIL = "pedroleitejoao398@gmail.com";
export const WHATSAPP_JPRH = "5573981443993";

export const firebaseConfig = {
  projectId: "jp-rh-eunapolis",
  appId: "1:389142219991:web:2c86d6a2890904163df492",
  storageBucket: "jp-rh-eunapolis.firebasestorage.app",
  apiKey: "AIzaSyA6CG7Aq_zCrm55lcuIvwxfAVUErGmbmuc",
  authDomain: "jp-rh-eunapolis.firebaseapp.com",
  messagingSenderId: "389142219991",
  measurementId: "G-3Y1QET9VEE"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
auth.languageCode = "pt-BR";
export const db = getFirestore(app);

export const PRIMARY_HOSTING_URL = "https://jp-rh-eunapolis.web.app";

export function getPasswordResetActionSettings() {
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const isAuthorizedOrigin =
    host === "jp-rh-eunapolis.web.app" ||
    host === "jp-rh-eunapolis.firebaseapp.com" ||
    host === "localhost" ||
    host === "127.0.0.1";
  const baseUrl = isAuthorizedOrigin
    ? `${window.location.origin}${window.location.pathname.replace(/\/[^/]*$/, "")}`
    : PRIMARY_HOSTING_URL;
  return {
    url: `${baseUrl}/trocar-senha.html?status=senha-atualizada`,
    handleCodeInApp: false
  };
}

let aiInstance = null;
try {
  aiInstance = getAI(app, { backend: new GoogleAIBackend() });
} catch (err) {
  console.warn("Firebase AI Logic indisponível no momento:", err);
}

export const ai = aiInstance;

export {
  getGenerativeModel,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  writeBatch
};
