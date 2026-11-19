// Firebase の読み込み（npm の firebase パッケージ）。shim.js からはこのファイル経由で使う
export { initializeApp } from 'firebase/app';
export { getAuth, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, signOut } from 'firebase/auth';
export { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, where, getDocs, writeBatch } from 'firebase/firestore';
