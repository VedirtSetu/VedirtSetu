import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  setLogLevel,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp,
} from 'firebase/firestore';

// Helper to sanitize any payload before writing to Firestore (prevents undefined field errors)
export const cleanDataForFirestore = (obj: any): any => {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (obj instanceof Date) return obj;
  // Preserve Firestore FieldValue sentinels (e.g. serverTimestamp) and non-plain custom classes
  if (obj._methodName || (obj.constructor && obj.constructor.name !== 'Object' && obj.constructor.name !== 'Array')) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.filter((item) => item !== undefined).map(cleanDataForFirestore);
  }
  const clean: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) {
      clean[key] = cleanDataForFirestore(val);
    }
  }
  return clean;
};


import appletConfig from '../../firebase-applet-config.json';

const getEnv = (key: string): string => {
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key]!;
  }
  try {
    if (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env[key]) {
      return (import.meta as any).env[key];
    }
  } catch (e) {}
  return '';
};

export const firestoreDatabaseId =
  getEnv('VITE_FIREBASE_FIRESTORE_DATABASE_ID') ||
  appletConfig.firestoreDatabaseId ||
  'ai-studio-vedirtsetub2bdis-9b7a0881-a7a2-4c2a-951e-3f4eadfeb89a';

export const firebaseConfig = {
  apiKey: getEnv('VITE_FIREBASE_API_KEY') || appletConfig.apiKey || "AIzaSyDt49DrDVceSg3J-miSELhsSYIpnJ6BhVg",
  authDomain: getEnv('VITE_FIREBASE_AUTH_DOMAIN') || appletConfig.authDomain || "vedirtsetu.firebaseapp.com",
  projectId: getEnv('VITE_FIREBASE_PROJECT_ID') || appletConfig.projectId || "vedirtsetu",
  storageBucket: getEnv('VITE_FIREBASE_STORAGE_BUCKET') || appletConfig.storageBucket || "vedirtsetu.firebasestorage.app",
  messagingSenderId: getEnv('VITE_FIREBASE_MESSAGING_SENDER_ID') || appletConfig.messagingSenderId || "298074864260",
  appId: getEnv('VITE_FIREBASE_APP_ID') || appletConfig.appId || "1:298074864260:web:f80fee4645b00d50f360d1",
  measurementId: getEnv('VITE_FIREBASE_MEASUREMENT_ID') || appletConfig.measurementId || ""
};

// Silence verbose internal Firestore WebChannel stream warnings
try {
  setLogLevel('error');
} catch (e) {}

// Initialize Firebase App singleton safely
export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// Initialize Firestore with robust connection options and offline IndexedDB persistence
export const firestoreDb = (() => {
  try {
    if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
      return initializeFirestore(
        app,
        {
          localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager(),
          }),
          experimentalAutoDetectLongPolling: true,
        },
        firestoreDatabaseId
      );
    }
    return initializeFirestore(
      app,
      {
        experimentalAutoDetectLongPolling: true,
      },
      firestoreDatabaseId
    );
  } catch (e) {
    try {
      return initializeFirestore(
        app,
        {
          experimentalAutoDetectLongPolling: true,
        },
        firestoreDatabaseId
      );
    } catch {
      return getFirestore(app, firestoreDatabaseId);
    }
  }
})();

// =========================================================================
// 1. DISTRIBUTORS CLOUD SYNC (PERMANENT STORAGE IN FIRESTORE)
// =========================================================================

/**
 * Save or update Distributor in Firestore 'distributors' and 'users' collection.
 * This guarantees the distributor and their login PIN never disappear on server restarts.
 */
export const saveDistributorToFirestore = async (distributorData: any): Promise<void> => {
  try {
    if (!distributorData) return;
    const isSuspended = distributorData.subscription_status === 'suspended';
    const activeStatus = isSuspended ? 0 : (distributorData.active_status !== undefined ? Number(distributorData.active_status) : 1);

    const docId = String(distributorData.id || distributorData.mobile || Date.now()).trim();
    const distDocRef = doc(firestoreDb, 'distributors', docId);

    // Ensure plaintext credentials and PINs are NEVER written to cloud Firestore (preserve encrypted password_hash)
    const { login_pin, pin, password, ...cleanDistributorData } = distributorData;
    const payload: any = {
      ...cleanDistributorData,
      active_status: activeStatus,
      is_deleted: 0,
      synced_at: new Date().toISOString(),
      updated_at_firestore: serverTimestamp(),
    };

    if (distributorData.mobile) {
      payload.mobile = String(distributorData.mobile).trim();
      try {
        if (typeof localStorage !== 'undefined') {
          const cleanMob = payload.mobile.replace(/\D/g, '');
          const mob10 = cleanMob.slice(-10);
          const stored = localStorage.getItem('vedirt_deleted_distributors');
          if (stored) {
            const filtered = (JSON.parse(stored) as string[]).filter(
              (x) => String(x).length >= 10 && x !== cleanMob && x !== mob10
            );
            localStorage.setItem('vedirt_deleted_distributors', JSON.stringify(filtered));
          }
        }
      } catch (e) {}
    }

    const safePayload = cleanDataForFirestore(payload);
    await setDoc(distDocRef, safePayload, { merge: true });

    // Also update by mobile docId and clear soft-delete flags on any older duplicate docs for this mobile
    if (distributorData.mobile) {
      const cleanMob = String(distributorData.mobile).replace(/\D/g, '');
      const mob10 = cleanMob.length >= 10 ? cleanMob.slice(-10) : cleanMob;
      if (docId !== String(distributorData.mobile).trim()) {
        const mobDocRef = doc(firestoreDb, 'distributors', String(distributorData.mobile).trim());
        await setDoc(mobDocRef, safePayload, { merge: true }).catch(() => {});
      }
      if (mob10) {
        const snap = await getDocs(collection(firestoreDb, 'distributors')).catch(() => null);
        if (snap && snap.docs) {
          for (const d of snap.docs) {
            const val = d.data() as any;
            const dMob10 = String(val?.mobile || '').replace(/\D/g, '').slice(-10);
            if (dMob10 === mob10 && d.id !== docId) {
              await setDoc(d.ref, safePayload, { merge: true }).catch(() => {});
            }
          }
        }
      }
    }

    // Also persist user profile in Firestore 'users' with encrypted password_hash (never plaintext PIN)
    if (distributorData.mobile) {
      const userDocRef = doc(firestoreDb, 'users', String(distributorData.mobile).trim());
      const userPayload: any = {
        name: distributorData.owner_name || distributorData.business_name || 'Distributor',
        mobile: String(distributorData.mobile).trim(),
        email: distributorData.email || `${distributorData.mobile}@wholesale.com`,
        role: 'admin',
        distributor_id: distributorData.id ? Number(distributorData.id) : undefined,
        business_name: distributorData.business_name,
        active_status: activeStatus,
        is_deleted: 0,
        ...(distributorData.password_hash ? { password_hash: distributorData.password_hash } : {}),
        updated_at: new Date().toISOString(),
      };
      await setDoc(userDocRef, cleanDataForFirestore(userPayload), { merge: true });
    }

    console.log(`[Firestore Cloud] Distributor ${docId} permanently saved in Firestore.`);
  } catch (error) {
    console.warn('[Firestore Cloud] Error saving distributor to Firestore:', error);
    throw error;
  }
};

/**
 * Fetch all Distributors from Firestore.
 */
export const getDistributorsFromFirestore = async (): Promise<any[]> => {
  try {
    const snapshot = await getDocs(collection(firestoreDb, 'distributors'));
    let isDemoDeleted = false;
    let deletedSet = new Set<string>();
    try {
      if (typeof localStorage !== 'undefined') {
        isDemoDeleted = localStorage.getItem('vedirt_demo_deleted') === '1';
        const stored = localStorage.getItem('vedirt_deleted_distributors');
        if (stored) {
          const parsed = JSON.parse(stored) as string[];
          // Keep only 10+ digit mobile numbers or non-numeric Firestore IDs (never short SQLite row IDs like "1", "2", "3")
          const validEntries = parsed.filter((x) => String(x).length >= 10 || isNaN(Number(x)));
          deletedSet = new Set(validEntries);
        }
      }
    } catch (e) {}

    // Track any mobile that has been soft-deleted on any duplicate document in Firestore
    const cloudDeletedMobiles = new Set<string>();
    snapshot.forEach((d) => {
      const val = d.data() as any;
      if (!val) return;
      const dMob10 = String(val.mobile || '').replace(/\D/g, '').slice(-10);
      const isDel =
        val.subscription_status === 'deleted' ||
        val.is_deleted === 1 ||
        val.is_deleted === true ||
        val.is_deleted === '1' ||
        val.is_deleted === 'true';
      if (isDel && dMob10) {
        cloudDeletedMobiles.add(dMob10);
      }
    });

    const dedupMap = new Map<string, any>();
    snapshot.forEach((d) => {
      const val = d.data() as any;
      if (!val) return;
      const dMob = String(val.mobile || '').replace(/\D/g, '');
      const dMob10 = dMob.slice(-10);
      const docId = String(d.id || '');

      // Exclude if tracked as deleted by mobile number
      if ((dMob && deletedSet.has(dMob)) || (dMob10 && deletedSet.has(dMob10)) || (docId.length >= 10 && deletedSet.has(docId))) return;
      if (dMob10 && cloudDeletedMobiles.has(dMob10)) return;
      if (isDemoDeleted && (dMob10 === '9876543210' || val.is_demo === 1 || String(val.business_name || '').includes('श्री गणेश'))) return;

      // Strictly exclude soft-deleted distributors
      if (
        val.subscription_status !== 'deleted' &&
        val.is_deleted !== 1 &&
        val.is_deleted !== true &&
        val.is_deleted !== '1' &&
        val.is_deleted !== 'true'
      ) {
        const key = dMob10 || docId;
        const existing = dedupMap.get(key) || {};
        dedupMap.set(key, { ...existing, firestore_id: d.id, ...val });
      }
    });
    return Array.from(dedupMap.values());
  } catch (error) {
    console.warn('[Firestore Cloud] Error fetching distributors from Firestore:', error);
    return [];
  }
};

/**
 * Delete Distributor from Firestore.
 */
export const deleteDistributorFromFirestore = async (
  distributorId?: string | number,
  mobile?: string,
  firestoreId?: string
): Promise<void> => {
  try {
    // 1. Soft delete updates (Data Firestore aur SQLite dono me 100% safe rahega, bas panel se hide aur login disable hoga)
    const updates = {
      subscription_status: 'deleted',
      active_status: 0,
      is_deleted: 1,
      deleted_at: new Date().toISOString(),
    };

    const cleanMob = mobile ? String(mobile).replace(/\D/g, '') : '';
    const mob10 = cleanMob.length >= 10 ? cleanMob.slice(-10) : cleanMob;
    const cleanId = distributorId !== undefined && distributorId !== null ? String(distributorId).trim() : '';

    // Track permanently in localStorage by 10-digit mobile (never store short SQLite row IDs like "2" or "3")
    try {
      if (typeof localStorage !== 'undefined') {
        if (cleanMob === '9876543210' || mob10 === '9876543210') {
          localStorage.setItem('vedirt_demo_deleted', '1');
        }
        const stored = localStorage.getItem('vedirt_deleted_distributors');
        const existingArr = stored ? (JSON.parse(stored) as string[]).filter((x) => String(x).length >= 10 || isNaN(Number(x))) : [];
        const set = new Set<string>(existingArr);
        if (cleanMob.length >= 10) set.add(cleanMob);
        if (mob10.length >= 10) set.add(mob10);
        if (firestoreId && (String(firestoreId).length >= 10 || isNaN(Number(firestoreId)))) set.add(String(firestoreId));
        localStorage.setItem('vedirt_deleted_distributors', JSON.stringify(Array.from(set)));
      }
    } catch (e) {}

    // 2. Direct keys par soft-delete flag update karein
    const directKeys = new Set<string>();
    if (firestoreId) directKeys.add(String(firestoreId).trim());
    if (cleanId) directKeys.add(cleanId);
    if (cleanMob) directKeys.add(cleanMob);
    if (mob10) directKeys.add(mob10);
    if (mobile) directKeys.add(String(mobile).trim());

    for (const k of directKeys) {
      if (k) {
        await setDoc(doc(firestoreDb, 'distributors', k), updates, { merge: true }).catch(() => {});
        await setDoc(doc(firestoreDb, 'users', k), { active_status: 0, is_deleted: 1 }, { merge: true }).catch(() => {});
      }
    }

    // 3. Collection sweep: 10-digit mobile number ya ID se match karke sabhi variants par soft-delete flag lagayein
    const snap = await getDocs(collection(firestoreDb, 'distributors')).catch(() => null);
    if (snap && snap.docs) {
      for (const d of snap.docs) {
        const val = d.data();
        const dMob = String(val.mobile || '').replace(/\D/g, '');
        const dMob10 = dMob.length >= 10 ? dMob.slice(-10) : dMob;
        const dId = String(val.id || '');

        const matchMob = mob10 && (dMob10 === mob10 || d.id === mob10 || d.id.endsWith(mob10));
        const matchId = cleanId && (dId === cleanId || d.id === cleanId);
        const matchFId = firestoreId && d.id === firestoreId;

        if (matchMob || matchId || matchFId) {
          await setDoc(d.ref, updates, { merge: true }).catch(() => {});
        }
      }
    }

    // 4. Distributor ki shops aur products ko soft-delete mark karein (unka purana hisab v orders 100% surakshit)
    if (cleanId) {
      const qShops = query(collection(firestoreDb, 'shops'), where('distributor_id', '==', Number(cleanId)));
      const snapShops = await getDocs(qShops).catch(() => null);
      if (snapShops) {
        for (const sd of snapShops.docs) {
          await setDoc(sd.ref, { active_status: 0, is_deleted: 1, is_distributor_deleted: 1, deleted_at: new Date().toISOString() }, { merge: true }).catch(() => {});
        }
      }

      const qProds = query(collection(firestoreDb, 'products'), where('distributor_id', '==', Number(cleanId)));
      const snapProds = await getDocs(qProds).catch(() => null);
      if (snapProds) {
        for (const pd of snapProds.docs) {
          await setDoc(pd.ref, { active_status: 0, is_deleted: 1, deleted_at: new Date().toISOString() }, { merge: true }).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.warn('[Firestore Cloud] Soft delete error:', error);
    throw error;
  }
};

/**
 * Update distributor status in Firestore (active, suspended, expired, etc.)
 */
export const updateDistributorStatusInFirestore = async (
  distributorId?: string | number,
  status?: string,
  mobile?: string,
  firestoreId?: string,
  paymentStatus?: string
): Promise<void> => {
  try {
    const updates: any = {
      updated_at_firestore: serverTimestamp(),
      synced_at: new Date().toISOString(),
    };
    let activeStatus: number | undefined = undefined;
    if (status) {
      const isSuspended = status === 'suspended' || status === 'deleted';
      activeStatus = isSuspended ? 0 : 1;
      updates.subscription_status = status;
      updates.active_status = activeStatus;
      if (status === 'deleted') {
        updates.is_deleted = 1;
        updates.deleted_at = new Date().toISOString();
      }
    }
    if (paymentStatus) {
      updates.payment_status = paymentStatus;
    }

    const cleanMob = mobile ? String(mobile).replace(/\D/g, '') : '';
    const cleanId = distributorId !== undefined && distributorId !== null ? String(distributorId).trim() : '';

    const directKeys = new Set<string>();
    if (firestoreId) directKeys.add(String(firestoreId).trim());
    if (cleanId) directKeys.add(cleanId);
    if (cleanMob) directKeys.add(cleanMob);
    if (mobile) directKeys.add(String(mobile).trim());

    for (const k of directKeys) {
      if (k) {
        await setDoc(doc(firestoreDb, 'distributors', k), cleanDataForFirestore(updates), { merge: true });
      }
    }

    if (cleanMob && activeStatus !== undefined) {
      await setDoc(doc(firestoreDb, 'users', cleanMob), cleanDataForFirestore({ active_status: activeStatus }), { merge: true });
    }

    const snap = await getDocs(collection(firestoreDb, 'distributors')).catch(() => null);
    if (snap && snap.docs) {
      for (const d of snap.docs) {
        const val = d.data();
        const dMob = String(val.mobile || '').replace(/\D/g, '');
        const dId = String(val.id || '');
        const matchMob = cleanMob && (dMob === cleanMob || d.id === cleanMob);
        const matchId = cleanId && (dId === cleanId || d.id === cleanId);
        const matchFId = firestoreId && d.id === firestoreId;
        if (matchMob || matchId || matchFId) {
          await setDoc(d.ref, cleanDataForFirestore(updates), { merge: true });
        }
      }
    }
  } catch (error) {
    console.warn('[Firestore Cloud] Error updating distributor status in Firestore:', error);
    throw error;
  }
};


/**
 * Real-time listener for Distributors.
 */
export const subscribeToFirestoreDistributors = (
  onDistributorsUpdated: (distributors: any[]) => void,
  onError?: (err: any) => void
): (() => void) => {
  try {
    const col = collection(firestoreDb, 'distributors');
    return onSnapshot(
      col,
      (snapshot) => {
        const deletedMobs = new Set<string>();
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as any;
          if (!data) return;
          const mob10 = String(data.mobile || '').replace(/\D/g, '').slice(-10);
          const isDel =
            data.subscription_status === 'deleted' ||
            Number(data.is_deleted) === 1 ||
            data.is_deleted === true ||
            data.is_deleted === '1' ||
            data.is_deleted === 'true';
          if (isDel && mob10) deletedMobs.add(mob10);
        });

        const distMap = new Map<string, any>();
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const mob10 = String(data?.mobile || '').replace(/\D/g, '').slice(-10);
          // Strictly filter out deleted distributors
          const isDel =
            !data ||
            (mob10 && deletedMobs.has(mob10)) ||
            data.subscription_status === 'deleted' ||
            Number(data.is_deleted) === 1 ||
            data.is_deleted === true ||
            data.is_deleted === '1' ||
            data.is_deleted === 'true';
          if (!isDel) {
            const key = mob10 || (data.id ? String(data.id).trim() : String(docSnap.id).trim());
            const existing = distMap.get(key) || {};
            distMap.set(key, { ...existing, firestore_id: docSnap.id, ...data });
          }
        });
        onDistributorsUpdated(Array.from(distMap.values()));
      },
      (error) => {
        console.warn('[Firestore Cloud] Distributors listener error:', error);
        if (onError) onError(error);
      }
    );
  } catch (error) {
    console.warn('[Firestore Cloud] Failed to initialize distributors listener:', error);
    return () => {};
  }
};

// =========================================================================
// 2. SHOPS & RETAILERS CLOUD SYNC
// =========================================================================

/**
 * Save Retailer / Shop data to Firestore 'shops' and 'users' collections.
 */
export const saveShopToFirestore = async (shopData: any): Promise<void> => {
  try {
    const docId = String(shopData.shop_code || shopData.id || Date.now());
    const shopDocRef = doc(firestoreDb, 'shops', docId);

    // Ensure plaintext credentials and PINs are NEVER written to cloud Firestore (preserve encrypted password_hash)
    const { pin, password, login_pin, ...cleanShopData } = shopData;

    await setDoc(
      shopDocRef,
      cleanDataForFirestore({
        ...cleanShopData,
        synced_at: new Date().toISOString(),
        updated_at_firestore: serverTimestamp(),
      }),
      { merge: true }
    );

    // Save shopkeeper profile in Firestore 'users' collection with encrypted password_hash (never plaintext PIN)
    if (shopData.mobile) {
      const userDocRef = doc(firestoreDb, 'users', String(shopData.mobile).trim());
      await setDoc(
        userDocRef,
        cleanDataForFirestore({
          name: shopData.owner_name || shopData.shop_name,
          mobile: String(shopData.mobile).trim(),
          email: shopData.email || `${shopData.mobile}@retailer.com`,
          role: 'retailer',
          shop_id: shopData.id,
          shop_name: shopData.shop_name,
          shop_code: shopData.shop_code,
          distributor_id: shopData.distributor_id ? Number(shopData.distributor_id) : undefined,
          active_status: shopData.active_status !== undefined ? Number(shopData.active_status) : 1,
          ...(shopData.password_hash ? { password_hash: shopData.password_hash } : {}),
          updated_at: new Date().toISOString(),
        }),
        { merge: true }
      );
    }

    console.log(`[Firestore Cloud] Shop ${docId} permanently saved in Firestore.`);
  } catch (error) {
    console.warn('[Firestore Cloud] Error saving shop to Firestore:', error);
    throw error;
  }
};

/**
 * Fetch all Shops from Firestore.
 */
export const getShopsFromFirestore = async (distributorId?: number): Promise<any[]> => {
  try {
    let q;
    if (distributorId) {
      q = query(collection(firestoreDb, 'shops'), where('distributor_id', '==', Number(distributorId)));
    } else {
      q = collection(firestoreDb, 'shops');
    }
    const snapshot = await getDocs(q);
    const shopMap = new Map<string, any>();
    snapshot.forEach((d) => {
      const val = d.data() as any;
      if (!val) return;
      const isDel =
        val.active_status === 0 ||
        val.active_status === '0' ||
        Number(val.active_status) === 0 ||
        val.is_deleted === true ||
        val.is_deleted === 1 ||
        val.is_deleted === '1' ||
        val.is_deleted === 'true' ||
        val.is_distributor_deleted === 1 ||
        val.is_distributor_deleted === true;
      if (!isDel) {
        // STRICT MULTI-TENANCY: Never allow shops from other distributors to leak
        if (!distributorId || Number(val.distributor_id) === Number(distributorId)) {
          const key = val.shop_code ? String(val.shop_code).trim().toUpperCase() : String(val.id || d.id).trim();
          shopMap.set(key, { firestore_id: d.id, ...val });
        }
      }
    });
    return Array.from(shopMap.values());
  } catch (error) {
    console.warn('[Firestore Cloud] Error fetching shops from Firestore:', error);
    return [];
  }
};

/**
 * Delete Shop from Firestore.
 */
export const deleteShopFromFirestore = async (shopCodeOrId: string | number, mobile?: string): Promise<void> => {
  try {
    const docId = String(shopCodeOrId);
    await setDoc(doc(firestoreDb, 'shops', docId), { active_status: 0, is_deleted: true }, { merge: true });
    if (mobile) {
      await setDoc(doc(firestoreDb, 'users', String(mobile).trim()), { active_status: 0 }, { merge: true });
    }
    const q = query(collection(firestoreDb, 'shops'), where('id', '==', Number(shopCodeOrId)));
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      await setDoc(d.ref, { active_status: 0, is_deleted: true }, { merge: true });
    }
    const q2 = query(collection(firestoreDb, 'shops'), where('shop_code', '==', String(shopCodeOrId)));
    const snap2 = await getDocs(q2);
    for (const d of snap2.docs) {
      await setDoc(d.ref, { active_status: 0, is_deleted: true }, { merge: true });
    }
    console.log(`[Firestore Cloud] Shop ${shopCodeOrId} soft-deleted in Firestore.`);
  } catch (error) {
    console.warn('[Firestore Cloud] Error soft-deleting shop in Firestore:', error);
    throw error;
  }
};

/**
 * Real-time listener for Shops.
 */
export const subscribeToFirestoreShops = (
  onShopsUpdated: (shops: any[]) => void,
  distributorId?: number,
  onError?: (err: any) => void
): (() => void) => {
  try {
    const col = collection(firestoreDb, 'shops');
    const q = distributorId ? query(col, where('distributor_id', '==', distributorId)) : col;
    return onSnapshot(
      q,
      (snapshot) => {
        const shopMap = new Map<string, any>();
        snapshot.forEach((docSnap) => {
          const val = docSnap.data() as any;
          if (!val) return;
          const isDel =
            val.active_status === 0 ||
            val.active_status === '0' ||
            Number(val.active_status) === 0 ||
            val.is_deleted === true ||
            val.is_deleted === 1 ||
            val.is_deleted === '1' ||
            val.is_deleted === 'true' ||
            val.is_distributor_deleted === 1 ||
            val.is_distributor_deleted === true;
          if (!isDel) {
            if (!distributorId || Number(val.distributor_id) === Number(distributorId)) {
              const key = val.shop_code ? String(val.shop_code).trim().toUpperCase() : String(val.id || docSnap.id).trim();
              const existing = shopMap.get(key) || {};
              shopMap.set(key, { ...existing, firestore_id: docSnap.id, ...val });
            }
          }
        });
        onShopsUpdated(Array.from(shopMap.values()));
      },
      (error) => {
        console.warn('[Firestore Cloud] Shops listener error:', error);
        if (onError) onError(error);
      }
    );
  } catch (error) {
    console.warn('[Firestore Cloud] Failed to initialize shops listener:', error);
    return () => {};
  }
};

// =========================================================================
// 3. PRODUCTS / INVENTORY CLOUD SYNC
// =========================================================================

/**
 * Save Product / Distributor Inventory data to Firestore 'products' collection.
 */
export const saveProductToFirestore = async (productData: any): Promise<void> => {
  try {
    if (!productData) return;
    const docId = String(productData.id || productData.code || Date.now());
    const prodDocRef = doc(firestoreDb, 'products', docId);
    await setDoc(
      prodDocRef,
      cleanDataForFirestore({
        ...productData,
        id: productData.id ? Number(productData.id) : Number(docId),
        distributor_id: productData.distributor_id ? Number(productData.distributor_id) : undefined,
        active_status: productData.active_status !== undefined ? Number(productData.active_status) : 1,
        synced_at: new Date().toISOString(),
        updated_at_firestore: serverTimestamp(),
      }),
      { merge: true }
    );
    console.log(`[Firestore Cloud] Product ${docId} stored in Firestore 'products' collection.`);
  } catch (error) {
    console.warn('[Firestore Cloud] Error saving product to Firestore:', error);
    throw error;
  }
};

/**
 * Fetch Products from Firestore.
 */
export const getProductsFromFirestore = async (distributorId?: number | string): Promise<any[]> => {
  try {
    const col = collection(firestoreDb, 'products');
    const targetDistId = distributorId != null && String(distributorId).trim() !== '' ? Number(distributorId) : null;
    const q: any = targetDistId ? query(col, where('distributor_id', '==', targetDistId)) : col;
    const snapshot = await getDocs(q);
    const list: any[] = [];

    snapshot.forEach((d) => {
      const val = d.data() as any;
      if (val && val.active_status !== 0 && !val.is_deleted && val.is_deleted !== 1 && val.is_deleted !== '1') {
        if (!targetDistId || Number(val.distributor_id) === targetDistId) {
          list.push({ firestore_id: d.id, ...val, id: val.id || Number(d.id) });
        }
      }
    });
    return list;
  } catch (error) {
    console.warn('[Firestore Cloud] Error fetching products from Firestore:', error);
    return [];
  }
};

/**
 * Delete Product from Firestore.
 */
export const deleteProductFromFirestore = async (productId: string | number): Promise<void> => {
  try {
    const docId = String(productId).trim();
    const updates = {
      active_status: 0,
      is_deleted: 1,
      deleted_at: new Date().toISOString(),
      updated_at_firestore: serverTimestamp(),
    };
    await setDoc(doc(firestoreDb, 'products', docId), updates, { merge: true }).catch(() => {});
    const q = query(collection(firestoreDb, 'products'), where('id', '==', Number(productId)));
    const snap = await getDocs(q).catch(() => null);
    if (snap && snap.docs) {
      for (const d of snap.docs) {
        await setDoc(d.ref, updates, { merge: true }).catch(() => {});
      }
    }
    console.log(`[Firestore Cloud] Product ${productId} soft-deleted in Firestore.`);
  } catch (error) {
    console.warn('[Firestore Cloud] Error deleting product from Firestore:', error);
    throw error;
  }
};

// =========================================================================
// 4. ORDERS CLOUD SYNC
// =========================================================================

/**
 * Store newly placed orders in the 'orders' collection in Firestore.
 * Canonical key: order_number (e.g. ORD-20261022-SH101-123).
 * Prevents creation of rogue/duplicate documents.
 */
export const saveOrderToFirestore = async (orderData: any): Promise<string | null> => {
  try {
    if (!orderData) return null;

    let docId = orderData.order_number ? String(orderData.order_number).trim() : null;

    // If order_number is not provided but numeric id is provided, check if a document already exists
    if (!docId && orderData.id) {
      const q = query(collection(firestoreDb, 'orders'), where('id', '==', Number(orderData.id)));
      const snap = await getDocs(q).catch(() => null);
      if (snap && !snap.empty) {
        // Find canonical document if one exists (not a rogue timestamp doc)
        const validDoc = snap.docs.find((d) => !d.id.match(/^ORD-\d{10,14}$/)) || snap.docs[0];
        docId = validDoc.id;
      }
    }

    if (!docId) {
      // Must only create new doc if creating a fresh order
      docId = orderData.id ? `ORD-${orderData.id}` : `ORD-${Date.now()}`;
    }

    const orderDocRef = doc(firestoreDb, 'orders', docId);

    const payload: any = {
      ...orderData,
      id: orderData.id ? Number(orderData.id) : undefined,
      order_number: orderData.order_number || docId,
      updated_at_firestore: serverTimestamp(),
      synced_at: new Date().toISOString(),
    };

    if (!orderData.created_at_firestore) {
      payload.created_at_firestore = serverTimestamp();
    }

    await setDoc(orderDocRef, cleanDataForFirestore(payload), { merge: true });
    console.log(`[Firestore Cloud] Order ${docId} stored in cloud Firestore 'orders' collection.`);
    return docId;
  } catch (error) {
    console.warn('[Firestore Cloud] Error saving order to Firestore:', error);
    throw error;
  }
};

/**
 * Update an existing order in Firestore (e.g., status change, cancellation, quantity edit).
 * Prevents creation of rogue/duplicate documents by strictly matching existing doc by order_number or numeric id.
 * Automatically cleans up any previously orphaned rogue timestamp documents.
 */
export const updateOrderInFirestore = async (
  orderIdentifier: { id?: number | string; order_number?: string },
  updates: any
): Promise<void> => {
  try {
    const rawOrderNumber = orderIdentifier.order_number ? String(orderIdentifier.order_number).trim() : null;
    const rawId = orderIdentifier.id != null && !isNaN(Number(orderIdentifier.id)) ? Number(orderIdentifier.id) : null;

    if (!rawOrderNumber && !rawId) {
      console.warn('[Firestore Cloud] updateOrderInFirestore skipped: Neither order_number nor id provided');
      return;
    }

    const payload = cleanDataForFirestore({
      ...updates,
      updated_at_firestore: serverTimestamp(),
      synced_at: new Date().toISOString(),
    });

    const matchedDocRefs: any[] = [];
    let canonicalDocId = rawOrderNumber;

    // 1. Direct document lookup by order_number if provided
    if (rawOrderNumber) {
      const directRef = doc(firestoreDb, 'orders', rawOrderNumber);
      const directSnap = await getDoc(directRef).catch(() => null);
      if (directSnap && directSnap.exists()) {
        matchedDocRefs.push(directRef);
        canonicalDocId = directSnap.id;
      }
    }

    // 2. Query orders collection by id to find any matching docs
    if (rawId) {
      const qId = query(collection(firestoreDb, 'orders'), where('id', '==', rawId));
      const snapId = await getDocs(qId).catch(() => null);
      if (snapId && !snapId.empty) {
        snapId.docs.forEach((d) => {
          if (!matchedDocRefs.some((r) => r.id === d.id)) {
            matchedDocRefs.push(d.ref);
            // If canonicalDocId not set, pick this doc unless it's a rogue timestamp ID
            if (!canonicalDocId || (!d.id.match(/^ORD-\d{10,14}$/) && d.data()?.order_number)) {
              canonicalDocId = d.data()?.order_number || d.id;
            }
          }
        });
      }
    }

    // 3. Query by order_number if not already found
    if (rawOrderNumber && matchedDocRefs.length === 0) {
      const qOrd = query(collection(firestoreDb, 'orders'), where('order_number', '==', rawOrderNumber));
      const snapOrd = await getDocs(qOrd).catch(() => null);
      if (snapOrd && !snapOrd.empty) {
        snapOrd.docs.forEach((d) => {
          if (!matchedDocRefs.some((r) => r.id === d.id)) {
            matchedDocRefs.push(d.ref);
            canonicalDocId = d.id;
          }
        });
      }
    }

    // 4. Update existing matched documents
    if (matchedDocRefs.length > 0) {
      // Find the primary canonical document reference
      const canonicalRef = matchedDocRefs.find((r) => r.id === canonicalDocId) || matchedDocRefs[0];
      await setDoc(canonicalRef, payload, { merge: true });

      // Clean up any rogue/duplicate documents created under timestamp IDs (e.g. ORD-1729...)
      for (const ref of matchedDocRefs) {
        if (ref.id !== canonicalRef.id) {
          if (ref.id.match(/^ORD-\d{10,14}$/) || (rawOrderNumber && ref.id !== rawOrderNumber)) {
            console.log(`[Firestore Cloud] Cleaned up rogue duplicate order document: ${ref.id}`);
            await deleteDoc(ref).catch(() => {});
          } else {
            await setDoc(ref, payload, { merge: true });
          }
        }
      }
      console.log(`[Firestore Cloud] Order updated in Firestore canonical doc: ${canonicalRef.id}`);
    } else if (rawOrderNumber) {
      // No doc in Firestore yet, but we have a valid order_number: write to canonical document
      const fallbackRef = doc(firestoreDb, 'orders', rawOrderNumber);
      await setDoc(
        fallbackRef,
        cleanDataForFirestore({
          id: rawId || undefined,
          order_number: rawOrderNumber,
          ...payload,
        }),
        { merge: true }
      );
      console.log(`[Firestore Cloud] Order updated in canonical document: ${rawOrderNumber}`);
    } else {
      // Suppress rogue document creation: DO NOT generate ORD-${Date.now()}
      console.warn(`[Firestore Cloud] Suppressed rogue document creation: Cannot update order #${rawId} because no matching Firestore document exists.`);
    }
  } catch (error) {
    console.warn('[Firestore Cloud] Error updating order in Firestore:', error);
    throw error;
  }
};

/**
 * Listen to orders in real-time using onSnapshot so distributor sees new orders instantly.
 * Scoped by distributorId or shopId to prevent cross-tenant data leaks and payload truncation.
 * Filters out rogue/incomplete timestamp documents.
 */
export const subscribeToFirestoreOrders = (
  onOrdersUpdated: (orders: any[]) => void,
  distributorId?: number | null,
  shopId?: number | null,
  onError?: (err: any) => void
): (() => void) => {
  try {
    const ordersCol = collection(firestoreDb, 'orders');
    let q;
    if (distributorId) {
      q = query(ordersCol, where('distributor_id', '==', Number(distributorId)));
    } else if (shopId) {
      q = query(ordersCol, where('shop_id', '==', Number(shopId)));
    } else {
      q = query(ordersCol, orderBy('synced_at', 'desc'), limit(50));
    }

    return onSnapshot(
      q,
      (snapshot) => {
        const orderMap = new Map<string, any>();
        snapshot.forEach((docSnap) => {
          const val = docSnap.data() as any;
          if (!val) return;
          if (distributorId && Number(val.distributor_id) !== Number(distributorId)) return;
          if (shopId && Number(val.shop_id) !== Number(shopId)) return;

          // Discard rogue incomplete timestamp documents (ORD-1729...) that lack shop_id or order_date
          const isRogueTimestampDoc = docSnap.id.match(/^ORD-\d{10,14}$/) && (!val.shop_id || !val.order_date);
          if (isRogueTimestampDoc) return;

          const key = val.order_number
            ? String(val.order_number).trim()
            : (val.id ? `ID_${val.id}` : docSnap.id);

          const existing = orderMap.get(key);
          // If we already have a canonical doc, don't overwrite with a timestamp doc
          if (existing && !existing.firestore_id.match(/^ORD-\d{10,14}$/) && docSnap.id.match(/^ORD-\d{10,14}$/)) {
            return;
          }

          orderMap.set(key, {
            firestore_id: docSnap.id,
            ...val,
          });
        });
        onOrdersUpdated(Array.from(orderMap.values()));
      },
      (error) => {
        console.warn('[Firestore Cloud] onSnapshot listener error:', error);
        if (onError) onError(error);
      }
    );
  } catch (error) {
    console.warn('[Firestore Cloud] Failed to initialize onSnapshot listener:', error);
    return () => {};
  }
};

/**
 * Fetch all Orders from Firestore Cloud for SQLite synchronization.
 * Filters out rogue/incomplete timestamp documents.
 */
export const getOrdersFromFirestore = async (distributorId?: number, shopId?: number): Promise<any[]> => {
  try {
    const ordersCol = collection(firestoreDb, 'orders');
    let q = query(ordersCol, limit(200));
    if (distributorId) {
      q = query(ordersCol, where('distributor_id', '==', Number(distributorId)), limit(200));
    } else if (shopId) {
      q = query(ordersCol, where('shop_id', '==', Number(shopId)), limit(200));
    }
    const snapshot = await getDocs(q);
    const orderMap = new Map<string, any>();
    snapshot.forEach((d) => {
      const val = d.data() as any;
      if (!val) return;

      // Discard rogue incomplete timestamp documents
      const isRogueTimestampDoc = d.id.match(/^ORD-\d{10,14}$/) && (!val.shop_id || !val.order_date);
      if (isRogueTimestampDoc) return;

      const key = val.order_number
        ? String(val.order_number).trim()
        : (val.id ? `ID_${val.id}` : d.id);

      const existing = orderMap.get(key);
      if (existing && !existing.firestore_id.match(/^ORD-\d{10,14}$/) && d.id.match(/^ORD-\d{10,14}$/)) {
        return;
      }

      orderMap.set(key, { firestore_id: d.id, ...val });
    });
    return Array.from(orderMap.values());
  } catch (error) {
    console.warn('[Firestore Cloud] Error fetching orders from Firestore:', error);
    return [];
  }
};

// =========================================================================
// 5. SETTINGS & SUBSCRIPTION PLANS
// =========================================================================

export const saveSettingsToFirestore = async (settingsData: any, distId?: number | string): Promise<void> => {
  try {
    const docKey = distId ? `distributor_${distId}` : 'general';
    await setDoc(doc(firestoreDb, 'settings', docKey), cleanDataForFirestore({
      ...settingsData,
      updated_at: new Date().toISOString(),
    }), { merge: true });

    // डिस्ट्रीब्यूटर का UPI व QR कोड सीधे उसके क्लाउड डॉक्युमेंट में भी परमानेंट सेव करें
    if (distId) {
      const distUpdates: any = {};
      if (settingsData.distributor_upi) distUpdates.distributor_upi = settingsData.distributor_upi;
      if (settingsData.distributor_qr_image !== undefined) distUpdates.distributor_qr_image = settingsData.distributor_qr_image;
      if (settingsData.distributor_name) distUpdates.distributor_name = settingsData.distributor_name;
      if (settingsData.distributor_mobile) distUpdates.distributor_mobile = settingsData.distributor_mobile;

      if (Object.keys(distUpdates).length > 0) {
        await setDoc(doc(firestoreDb, 'distributors', String(distId).trim()), cleanDataForFirestore(distUpdates), { merge: true }).catch(() => {});
      }
    }
  } catch (error) {
    console.warn('[Firestore Cloud] Error saving settings to Firestore:', error);
    throw error;
  }
};

export const getSettingsFromFirestore = async (distId?: number | string): Promise<any | null> => {
  try {
    const docKey = distId ? `distributor_${distId}` : 'general';
    const snap = await getDoc(doc(firestoreDb, 'settings', docKey));
    let data: any = snap.exists() ? snap.data() : {};

    // अगर distId है, तो डिस्ट्रीब्यूटर डॉक्युमेंट से भी बैकअप QR व UPI लोड करें
    if (distId) {
      const distSnap = await getDoc(doc(firestoreDb, 'distributors', String(distId).trim())).catch(() => null);
      if (distSnap && distSnap.exists()) {
        const dData = distSnap.data();
        if (dData.distributor_upi) data.distributor_upi = dData.distributor_upi;
        if (dData.distributor_qr_image) data.distributor_qr_image = dData.distributor_qr_image;
      }
    }
    return Object.keys(data).length > 0 ? data : null;
  } catch (error) {
    console.warn('[Firestore Cloud] Error getting settings from Firestore:', error);
    return null;
  }
};

// =========================================================================
// 6. MASTER USER LOOKUP (FALLBACK DIRECT TO FIRESTORE)
// =========================================================================

export const findUserInFirestore = async (identifier: string): Promise<any | null> => {
  try {
    const clean = String(identifier || '').trim();
    if (!clean) return null;
    const cleanUpper = clean.toUpperCase();
    const cleanDigits = clean.replace(/\D/g, '');
    const tenDigits = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;

    let userRecord: any = null;

    // 1. Direct doc lookup in 'users' by raw identifier or 10-digit mobile
    const docSnap = await getDoc(doc(firestoreDb, 'users', clean));
    if (docSnap.exists()) {
      userRecord = { id: docSnap.id, ...docSnap.data() };
    }
    if (!userRecord && tenDigits && tenDigits !== clean) {
      const snap10 = await getDoc(doc(firestoreDb, 'users', tenDigits));
      if (snap10.exists()) {
        userRecord = { id: snap10.id, ...snap10.data() };
      }
    }

    // 2. Query 'users' by mobile or shop_code
    if (!userRecord) {
      const q = query(collection(firestoreDb, 'users'), where('mobile', '==', clean));
      const querySnap = await getDocs(q);
      if (!querySnap.empty) {
        userRecord = { id: querySnap.docs[0].id, ...querySnap.docs[0].data() };
      }
    }
    if (!userRecord && tenDigits && tenDigits !== clean) {
      const q10 = query(collection(firestoreDb, 'users'), where('mobile', '==', tenDigits));
      const snapQ10 = await getDocs(q10);
      if (!snapQ10.empty) {
        userRecord = { id: snapQ10.docs[0].id, ...snapQ10.docs[0].data() };
      }
    }
    if (!userRecord) {
      const qCode = query(collection(firestoreDb, 'users'), where('shop_code', '==', cleanUpper));
      const snapCode = await getDocs(qCode);
      if (!snapCode.empty) {
        userRecord = { id: snapCode.docs[0].id, ...snapCode.docs[0].data() };
      }
    }

    // 3. Enrich or fallback from 'distributors' and 'shops' collections
    const lookupMob = String(userRecord?.mobile || tenDigits || clean).trim();
    if (!userRecord || userRecord.role === 'admin') {
      let distData: any = null;
      if (lookupMob) {
        const dSnap = await getDoc(doc(firestoreDb, 'distributors', lookupMob));
        if (dSnap.exists()) distData = { id: dSnap.id, ...dSnap.data() };
        if (!distData) {
          const qDist = query(collection(firestoreDb, 'distributors'), where('mobile', '==', lookupMob));
          const sDist = await getDocs(qDist);
          if (!sDist.empty) distData = { id: sDist.docs[0].id, ...sDist.docs[0].data() };
        }
      }
      if (distData) {
        userRecord = {
          ...distData,
          ...userRecord,
          role: 'admin',
          name: userRecord?.name || distData.owner_name || distData.business_name || 'Distributor',
          password_hash: userRecord?.password_hash || distData.password_hash,
          is_deleted: distData.is_deleted ?? userRecord?.is_deleted ?? 0,
          subscription_status: distData.subscription_status || userRecord?.subscription_status || 'active',
          active_status: distData.active_status ?? userRecord?.active_status ?? 1,
        };
      }
    }

    if (!userRecord || userRecord.role === 'retailer') {
      let shopData: any = null;
      if (lookupMob) {
        const qShopMob = query(collection(firestoreDb, 'shops'), where('mobile', '==', lookupMob));
        const sShopMob = await getDocs(qShopMob);
        if (!sShopMob.empty) shopData = { id: sShopMob.docs[0].id, ...sShopMob.docs[0].data() };
      }
      if (!shopData) {
        const qShopCode = query(collection(firestoreDb, 'shops'), where('shop_code', '==', cleanUpper));
        const sShopCode = await getDocs(qShopCode);
        if (!sShopCode.empty) shopData = { id: sShopCode.docs[0].id, ...sShopCode.docs[0].data() };
      }
      if (shopData) {
        userRecord = {
          ...shopData,
          ...userRecord,
          role: 'retailer',
          name: userRecord?.name || shopData.owner_name || shopData.shop_name || 'Shopkeeper',
          password_hash: userRecord?.password_hash || shopData.password_hash,
          is_deleted: shopData.is_deleted ?? userRecord?.is_deleted ?? 0,
          active_status: shopData.active_status ?? userRecord?.active_status ?? 1,
        };
      }
    }

    return userRecord;
  } catch (error) {
    console.warn('[Firestore Cloud] Error finding user in Firestore:', error);
    return null;
  }
};

// =========================================================================
// SUBSCRIPTION PLANS CLOUD SYNC
// =========================================================================

export const saveSubscriptionPlansToFirestore = async (plans: any[]): Promise<void> => {
  try {
    for (const plan of plans) {
      if (plan.id) {
        await setDoc(doc(firestoreDb, 'subscription_plans', String(plan.id)), cleanDataForFirestore(plan), { merge: true });
      }
    }
  } catch (error) {
    console.warn('[Firestore Cloud] Error saving plans to Firestore:', error);
    throw error;
  }
};

export const getSubscriptionPlansFromFirestore = async (): Promise<any[]> => {
  try {
    const snap = await getDocs(collection(firestoreDb, 'subscription_plans'));
    const list: any[] = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    return list;
  } catch (error) {
    console.warn('[Firestore Cloud] Error getting subscription plans:', error);
    return [];
  }
};
/**
 * Save Subscription Payment to Firestore Cloud
 */
export const saveSubscriptionPaymentToFirestore = async (paymentData: any): Promise<void> => {
  try {
    if (!paymentData) return;
    const rawRef = String(paymentData.reference_no || '').trim();
    const distPart = paymentData.distributor_id || '0';
    const idPart = paymentData.id || Date.now();
    const effectiveRef =
      !rawRef || rawRef === 'SUB-NEW-REG'
        ? `SUB-NEW-REG-${distPart}-${idPart}`
        : rawRef;
    const docId = effectiveRef;
    const payDocRef = doc(firestoreDb, 'subscription_payments', docId);
    const payload = cleanDataForFirestore({
      ...paymentData,
      id: paymentData.id || docId,
      reference_no: effectiveRef,
      updated_at_firestore: serverTimestamp(),
      synced_at: new Date().toISOString(),
    });
    await setDoc(payDocRef, payload, { merge: true });
    console.log(`[Firestore Cloud] Subscription payment ${docId} stored in cloud.`);
  } catch (error) {
    console.warn('[Firestore Cloud] Error saving subscription payment to Firestore:', error);
    throw error;
  }
};

/**
 * Get all Subscription Payments from Firestore Cloud
 */
export const getSubscriptionPaymentsFromFirestore = async (): Promise<any[]> => {
  try {
    const snapshot = await getDocs(collection(firestoreDb, 'subscription_payments'));
    const list: any[] = [];
    snapshot.forEach((d) => {
      list.push({ firestore_id: d.id, ...d.data() });
    });
    return list;
  } catch (error) {
    console.warn('[Firestore Cloud] Error fetching subscription payments from Firestore:', error);
    return [];
  }
};

/**
 * Save Retailer Shop Payment to Firestore Cloud
 */
export const savePaymentToFirestore = async (paymentData: any): Promise<void> => {
  try {
    if (!paymentData) return;
    const docId = String(paymentData.id || `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`).trim();
    const payDocRef = doc(firestoreDb, 'payments', docId);
    const payload = cleanDataForFirestore({
      ...paymentData,
      id: paymentData.id ? Number(paymentData.id) : undefined,
      shop_id: paymentData.shop_id ? Number(paymentData.shop_id) : undefined,
      distributor_id: paymentData.distributor_id ? Number(paymentData.distributor_id) : undefined,
      amount: Number(paymentData.amount) || 0,
      payment_date: paymentData.payment_date || new Date().toISOString().split('T')[0],
      payment_mode: paymentData.payment_mode || 'Cash',
      notes: paymentData.notes || '',
      status: paymentData.status || 'approved',
      updated_at_firestore: serverTimestamp(),
      synced_at: new Date().toISOString(),
    });
    await setDoc(payDocRef, payload, { merge: true });
    console.log(`[Firestore Cloud] Retailer payment ${docId} stored in cloud.`);
  } catch (error) {
    console.warn('[Firestore Cloud] Error saving retailer payment to Firestore:', error);
    throw error;
  }
};

/**
 * Get Retailer Shop Payments from Firestore Cloud
 */
export const getPaymentsFromFirestore = async (distributorId?: number, shopId?: number): Promise<any[]> => {
  try {
    const col = collection(firestoreDb, 'payments');
    const targetDist = distributorId ? Number(distributorId) : null;
    const targetShop = shopId ? Number(shopId) : null;

    let q: any = col;
    if (targetDist && targetShop) {
      q = query(col, where('distributor_id', '==', targetDist), where('shop_id', '==', targetShop));
    } else if (targetDist) {
      q = query(col, where('distributor_id', '==', targetDist));
    } else if (targetShop) {
      q = query(col, where('shop_id', '==', targetShop));
    }

    const snapshot = await getDocs(q);
    const list: any[] = [];

    snapshot.forEach((d) => {
      const val = d.data() as any;
      if (!val) return;
      if (targetDist && val.distributor_id && Number(val.distributor_id) !== targetDist) return;
      if (targetShop && val.shop_id && Number(val.shop_id) !== targetShop) return;
      list.push({ firestore_id: d.id, ...val });
    });
    return list;
  } catch (error) {
    console.warn('[Firestore Cloud] Error fetching retailer payments from Firestore:', error);
    return [];
  }
};

/**
 * Update Retailer Shop Payment Status in Firestore Cloud
 */
export const updatePaymentInFirestore = async (paymentId: number | string, updates: any): Promise<void> => {
  try {
    if (!paymentId) return;
    const docId = String(paymentId).trim();
    const payDocRef = doc(firestoreDb, 'payments', docId);
    await setDoc(
      payDocRef,
      cleanDataForFirestore({
        ...updates,
        updated_at_firestore: serverTimestamp(),
      }),
      { merge: true }
    );

    const q = query(collection(firestoreDb, 'payments'), where('id', '==', Number(paymentId)));
    const snap = await getDocs(q).catch(() => null);
    if (snap && snap.docs) {
      for (const d of snap.docs) {
        if (d.id !== docId) {
          await setDoc(
            d.ref,
            cleanDataForFirestore({
              ...updates,
              updated_at_firestore: serverTimestamp(),
            }),
            { merge: true }
          );
        }
      }
    }
  } catch (error) {
    console.warn('[Firestore Cloud] Error updating payment in Firestore:', error);
    throw error;
  }
};