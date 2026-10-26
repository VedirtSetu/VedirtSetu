import {
  getSubscriptionPlansFromFirestore,
  getSettingsFromFirestore,
  getDistributorsFromFirestore,
  getShopsFromFirestore,
  getProductsFromFirestore,
  getOrdersFromFirestore,
  getSubscriptionPaymentsFromFirestore,
  getPaymentsFromFirestore,
  findUserInFirestore,
} from './firebase.ts';
import {
  User,
  Shop,
  Product,
  Order,
  Payment,
  Notification,
  AuditLog,
  SystemSettings,
  OrderStatus,
  CutoffStatus,
  Distributor,
  SubscriptionPayment,
  SubscriptionPlan,
  SuperAdminMetrics,
  DistributorMonitoringData,
  SubscriptionStatus,
  SuperAdminNetworkOrdersResponse,
  RetailerDistributorInfo,
} from '../types/index.ts';

// -------------------------------------------------------------
// 1. CONSTANTS & STORAGE CONFIGURATION
// -------------------------------------------------------------
const TOKEN_KEY = 'doodhsetu_token';
const DEFAULT_TIMEOUT_MS = 20000;

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  params?: Record<string, string | number | boolean | undefined | null>;
}

// -------------------------------------------------------------
// 2. CUSTOM API ERROR CLASS
// -------------------------------------------------------------
export class ApiError extends Error {
  public status: number;
  public data?: any;
  public isNetworkError: boolean;

  constructor(message: string, status = 0, data?: any, isNetworkError = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.isNetworkError = isNetworkError;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// -------------------------------------------------------------
// 3. JWT & TOKEN STORAGE SERVICE
// -------------------------------------------------------------
export const tokenStorage = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },

  set: (token: string | null): void => {
    try {
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch (e) {
      console.warn('Failed to access localStorage for token:', e);
    }
  },

  clear: (): void => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      console.warn('Failed to clear token:', e);
    }
  },

  hasToken: (): boolean => {
    return Boolean(tokenStorage.get());
  },

  // Safely parses JWT payload claims if JWT format is used
  parseJwtPayload: <T = any>(): T | null => {
    const token = tokenStorage.get();
    if (!token) return null;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonPayload) as T;
    } catch {
      return null;
    }
  },
};

// Aliases for full backward compatibility
export const getStoredToken = tokenStorage.get;
export const setStoredToken = tokenStorage.set;

// -------------------------------------------------------------
// 4. CENTRALIZED REQUEST CLIENT WITH TIMEOUT & ERROR HANDLING
// -------------------------------------------------------------
async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const token = tokenStorage.get();
  const { timeoutMs = DEFAULT_TIMEOUT_MS, params, ...fetchOptions } = options;

  // Build query string if params supplied
  let finalEndpoint = endpoint;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, val]) => {
      if (val !== undefined && val !== null && val !== '') {
        searchParams.append(key, String(val));
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      finalEndpoint += (endpoint.includes('?') ? '&' : '?') + queryString;
    }
  }

  // Build HTTP headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...((fetchOptions.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Timeout handler with AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Check client-side connectivity
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new ApiError('इंटरनेट कनेक्शन नहीं है। कृपया नेटवर्क जांचें। (No internet connection)', 0, null, true);
    }

    const response = await fetch(finalEndpoint, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle 401 Unauthorized (Expired or Invalid token)
    if (response.status === 401) {
      tokenStorage.clear();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('doodhsetu_auth_logout'));
      }
      throw new ApiError(
        'सत्र समाप्त हो गया है। कृपया पुनः लॉगिन करें। (Session expired, please login again)',
        401
      );
    }

    // Parse JSON safely
    let responseData: any = null;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      try {
        responseData = await response.json();
      } catch {
        responseData = null;
      }
    } else {
      const text = await response.text();
      try {
        responseData = JSON.parse(text);
      } catch {
        responseData = text;
      }
    }

    // Check HTTP status code
    if (!response.ok) {
      let errorMessage = '';
      if (responseData) {
        if (typeof responseData === 'string') {
          if (responseData.includes('<html') || responseData.includes('<!DOCTYPE')) {
            errorMessage = response.status === 403
              ? 'पहुँच अस्वीकृत (403 Forbidden): इस कार्य के लिए अनुमति नहीं है।'
              : `सर्वर त्रुटि (${response.status})`;
          } else {
            errorMessage = responseData;
          }
        } else if (typeof responseData === 'object') {
          if (typeof responseData.error === 'string') {
            errorMessage = responseData.error;
          } else if (responseData.error && typeof responseData.error.message === 'string') {
            errorMessage = responseData.error.message;
          } else if (typeof responseData.message === 'string') {
            errorMessage = responseData.message;
          } else if (responseData.error) {
            try {
              errorMessage = typeof responseData.error === 'object' ? JSON.stringify(responseData.error) : String(responseData.error);
            } catch {
              errorMessage = '';
            }
          }
        }
      }

      if (!errorMessage || errorMessage === '[object Object]') {
        errorMessage = `अनपेक्षित सर्वर त्रुटि (${response.status}) / Server error (${response.status})`;
      }

      throw new ApiError(errorMessage, response.status, responseData);
    }

    return responseData as T;
  } catch (error: any) {
    clearTimeout(timeoutId);

    if (error instanceof ApiError) {
      throw error;
    }

    // Check AbortController timeout
    if (error.name === 'AbortError') {
      throw new ApiError('अनुरोध समय समाप्त (Request timed out). कृपया पुनः प्रयास करें।', 408, null, true);
    }

    // Check generic fetch failure (Server down / CORS / network drop)
    if (error.name === 'TypeError' || error.message?.includes('Failed to fetch')) {
      throw new ApiError(
        'नेटवर्क त्रुटि: सर्वर से संपर्क नहीं हो पा रहा है। (Network error: Unable to connect to server)',
        0,
        null,
        true
      );
    }

    const rawMsg = error?.message;
    const cleanMsg =
      typeof rawMsg === 'string' && rawMsg !== '[object Object]'
        ? rawMsg
        : typeof error === 'string' && error !== '[object Object]'
        ? error
        : 'अज्ञात त्रुटि (Unknown error)';

    throw new ApiError(cleanMsg, 0, error);
  }
}

// -------------------------------------------------------------
// 5. GENERIC HTTP CRUD HELPER METHODS
// -------------------------------------------------------------
export const http = {
  get: <T>(url: string, params?: Record<string, any>, options?: RequestOptions): Promise<T> =>
    request<T>(url, { ...options, method: 'GET', params }),

  post: <T>(url: string, body?: any, options?: RequestOptions): Promise<T> =>
    request<T>(url, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  put: <T>(url: string, body?: any, options?: RequestOptions): Promise<T> =>
    request<T>(url, {
      ...options,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  patch: <T>(url: string, body?: any, options?: RequestOptions): Promise<T> =>
    request<T>(url, {
      ...options,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  delete: <T>(url: string, options?: RequestOptions): Promise<T> =>
    request<T>(url, { ...options, method: 'DELETE' }),
};

// -------------------------------------------------------------
// 6. RESOURCE DOMAIN SERVICES
// -------------------------------------------------------------

// Authentication & Profile Services
export const authApi = {
  login: async (credentials: { identifier: string; pin?: string; password?: string }) => {
    try {
      return await http.post<{ token: string; user: User }>('/api/auth/login', credentials);
    } catch (err: any) {
      const isNotFound = err?.status === 404 || err?.statusCode === 404 || String(err?.message || err?.error || '').includes('पंजीकृत नहीं');
      if (isNotFound && credentials.identifier) {
        try {
          const cloudUser = await findUserInFirestore(credentials.identifier);
          if (cloudUser) {
            return await http.post<{ token: string; user: User }>('/api/auth/login', {
              ...credentials,
              cloud_user: cloudUser,
            });
          }
        } catch (cloudErr) {
          console.warn('[Cloud Login Fallback] Error fetching user from Firestore:', cloudErr);
        }
      }
      throw err;
    }
  },

  getMe: () => http.get<User>('/api/auth/me'),

  registerShop: (data: {
    shop_name: string;
    owner_name: string;
    mobile: string;
    address?: string;
    area?: string;
    route?: string;
    password?: string;
  }) => http.post<{ token: string; user: User }>('/api/auth/register-shop', data),

  changePassword: (current_password: string, new_password: string) =>
    http.post<{ success: boolean; message: string }>('/api/auth/change-password', {
      current_password,
      new_password,
    }),

  sendOtp: (mobile: string) =>
    http.post<{ success: boolean; message: string; simulatedOtp: string }>('/api/auth/send-otp', { mobile }),

  logout: () => {
    tokenStorage.clear();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('doodhsetu_auth_logout'));
    }
  },
};

// Session cache tracking to prevent duplicate or repeated cloud restore loops
const restoredSessionCache = new Set<string>();

export const clearRestoreSessionCache = () => {
  restoredSessionCache.clear();
};

// Product Catalogue & Pricing Services
export const productApi = {
  getAll: async (params?: { category?: string; in_stock?: boolean; distributor_id?: number }) => {
    let list = await http.get<Product[]>('/api/products', params).catch(() => []);

    // Cold-start fallback: Only restore if DB returned empty, NO category filter is applied, and not already restored this session
    const hasFilter = Boolean(params?.category || params?.in_stock !== undefined);
    const cacheKey = `products_${params?.distributor_id || 'all'}`;

    if ((!list || list.length === 0) && !hasFilter && !restoredSessionCache.has(cacheKey)) {
      restoredSessionCache.add(cacheKey);
      try {
        const cloudProducts = await getProductsFromFirestore(params?.distributor_id);
        if (cloudProducts && cloudProducts.length > 0) {
          await http.post('/api/sync/restore-from-firestore', { products: cloudProducts }).catch(() => {});
          list = await http.get<Product[]>('/api/products', params).catch(() => cloudProducts as any);
        }
      } catch (e) {
        console.warn('[Products Cloud Fallback] Error:', e);
      }
    }

    return list || [];
  },
  getAllWithFallback: async (distributorId?: number) => {
    return productApi.getAll(distributorId ? { distributor_id: distributorId } : undefined);
  },

  getById: (id: number) => http.get<Product>(`/api/products/${id}`),

  create: async (productData: Partial<Product>) => {
    return http.post<{ id: number; distributor_id?: number; message: string }>('/api/products', productData);
  },

  update: async (id: number, productData: Partial<Product>) => {
    return http.put<{ message: string }>(`/api/products/${id}`, productData);
  },

  delete: async (id: number) => {
    return http.delete<{ message: string }>(`/api/products/${id}`);
  },

  setCustomPrice: (productId: number, shop_id: number, custom_price: number) =>
    http.post<{ message: string }>(`/api/products/${productId}/custom-price`, { shop_id, custom_price }),
};

// Orders & Cutoff Management Services
export const orderApi = {
  getAll: async (params: {
    date?: string;
    status?: string;
    route?: string;
    area?: string;
    shop_id?: number;
    search?: string;
    limit?: number;
    distributor_id?: number;
  } = {}) => {
    let orders = await http.get<Order[]>('/api/orders', params).catch(() => []);

    // NEVER trigger cloud fetch & restore loop on filtered queries (date, status, route, area, search, shop_id)!
    // An empty result for a filtered query is a completely normal, expected query result.
    const hasFilter = Boolean(
      params.date ||
      params.status ||
      params.route ||
      params.area ||
      params.search ||
      params.shop_id
    );

    const cacheKey = `orders_${params.distributor_id || 'all'}`;

    // Cold-start fallback: Only if NO filters are present, backend returned empty, and not already restored this session
    if ((!orders || orders.length === 0) && !hasFilter && !restoredSessionCache.has(cacheKey)) {
      restoredSessionCache.add(cacheKey);
      try {
        const cloudOrders = await getOrdersFromFirestore(params.distributor_id, params.shop_id).catch(() => []);
        if (cloudOrders && cloudOrders.length > 0) {
          await http.post('/api/sync/restore-from-firestore', { orders: cloudOrders }).catch(() => {});
          orders = await http.get<Order[]>('/api/orders', params).catch(() => cloudOrders as any);
        }
      } catch (e) {
        console.warn('[Orders Cloud Fallback] Error:', e);
      }
    }

    return orders || [];
  },

  getById: (id: number) => http.get<Order>(`/api/orders/${id}`),

  create: async (orderData: {
    shop_id?: number;
    items: { product_id: number; quantity: number }[];
    notes?: string;
    order_date?: string;
  }) => {
    const res = await http.post<{
      id: number;
      order_number: string;
      total_amount: number;
      cutoff_status: CutoffStatus;
      message: string;
      order_date?: string;
      shop_id?: number;
      shop_name?: string;
      distributor_id?: number;
      items?: any[];
    }>(
      '/api/orders',
      orderData
    );

    return res;
  },

  update: async (id: number, updateData: { items: any[]; status?: OrderStatus; notes?: string; reason?: string }) => {
    return http.put<{
      message: string;
      total_amount: number;
      order_id?: number;
      order_number?: string;
      status?: OrderStatus;
      order?: any;
    }>(`/api/orders/${id}`, updateData);
  },

  cancel: async (id: number, reason?: string) => {
    return http.post<{
      message: string;
      order_id?: number;
      order_number?: string;
      status?: string;
    }>(`/api/orders/${id}/cancel`, { reason });
  },

  updateStatus: async (id: number, statusData: { status: OrderStatus; items?: any[]; reason?: string }) => {
    return http.post<{
      message: string;
      status: OrderStatus;
      order_id?: number;
      order_number?: string;
      total_amount?: number;
    }>(`/api/orders/${id}/status`, statusData);
  },

  repeatLast: () => http.post<{ items: { product_id: number; quantity: number }[] }>('/api/orders/repeat-last'),

  saveRegularDefaults: (shop_id: number, items: { product_id: number; quantity: number }[]) =>
    http.post<{ message: string }>('/api/orders/save-regular', { shop_id, items }),

  getRegularDefaults: (shop_id?: number) =>
    http.get<any[]>('/api/orders/regular-defaults', { shop_id }),
};

// Consolidated Demand Services
export const demandApi = {
  getConsolidated: (date?: string, distributor_id?: number, route?: string) =>
    http.get<{
      date: string;
      summary: {
        total_shops_ordered: number;
        overall_ordered_units: number;
        overall_delivered_units: number;
        overall_pending_units: number;
        overall_amount: number;
      };
      items: any[];
    }>('/api/demand', { date, distributor_id, route }),
};

// Shops Management & Ledger Services
export const shopApi = {
  getNextShopCode: () => http.get<{ next_code: string; next_number: number }>('/api/shops/next-code'),
  getAll: async (params?: { distributor_id?: number }) => {
    let list = await http.get<Shop[]>('/api/shops', params).catch(() => []);
    const cacheKey = `shops_${params?.distributor_id || 'all'}`;

    if ((!list || list.length === 0) && params?.distributor_id && !restoredSessionCache.has(cacheKey)) {
      restoredSessionCache.add(cacheKey);
      try {
        const cloudShops = await getShopsFromFirestore(params.distributor_id);
        if (cloudShops && cloudShops.length > 0) {
          await http.post('/api/sync/restore-from-firestore', { shops: cloudShops }).catch(() => {});
          list = await http.get<Shop[]>('/api/shops', params).catch(() => cloudShops as any);
        }
      } catch (e) {
        console.warn('[Shops Cloud Fallback] Error:', e);
      }
    }
    return list || [];
  },

  getById: (id: number) => http.get<Shop>(`/api/shops/${id}`),

  create: async (shopData: any) => {
    return http.post<{ id: number; user_id: number; message: string }>('/api/shops', shopData);
  },

  update: async (id: number, shopData: any) => {
    return http.put<{ message: string }>(`/api/shops/${id}`, shopData);
  },

  delete: async (id: number, _shopCode?: string, _mobile?: string) => {
    return http.delete<{ message: string }>(`/api/shops/${id}`);
  },

  getLedger: async (id: number) => {
    let ledger = await http.get<{
      shop: Shop;
      summary: { total_billed: number; total_paid: number; total_pending: number; pending_orders_amount?: number; balance: number };
      orders: any[];
      pending_orders?: any[];
      payments: any[];
    }>(`/api/shops/${id}/ledger`);

    const cacheKey = `ledger_payments_${id}`;
    if (ledger && (!ledger.payments || ledger.payments.length === 0) && ledger.orders && ledger.orders.length > 0 && !restoredSessionCache.has(cacheKey)) {
      restoredSessionCache.add(cacheKey);
      try {
        const cloudPayments = await getPaymentsFromFirestore(undefined, id);
        if (cloudPayments && cloudPayments.length > 0) {
          await http.post('/api/sync/restore-from-firestore', { payments: cloudPayments }).catch(() => {});
          ledger = await http.get<{
            shop: Shop;
            summary: { total_billed: number; total_paid: number; total_pending: number; pending_orders_amount?: number; balance: number };
            orders: any[];
            pending_orders?: any[];
            payments: any[];
          }>(`/api/shops/${id}/ledger`).catch(() => ledger);
        }
      } catch (e) {}
    }
    return ledger;
  },

  resetPin: async (id: number, pin: string) => {
    return http.post<{ success: boolean; message: string; mobile?: string; shop_code?: string }>(
      `/api/shops/${id}/reset-pin`,
      { pin }
    );
  },
};

// Payments & Collections Services
export const paymentApi = {
  getAll: async (params: { shop_id?: number; date?: string; distributor_id?: number } = {}) => {
    let payments = await http.get<Payment[]>('/api/payments', params).catch(() => []);

    // NEVER restore on date-filtered or shop-filtered queries (0 payments on a given date is normal)
    const hasFilter = Boolean(params.date || params.shop_id);
    const cacheKey = `payments_${params.distributor_id || 'all'}`;

    if ((!payments || payments.length === 0) && !hasFilter && !restoredSessionCache.has(cacheKey)) {
      restoredSessionCache.add(cacheKey);
      try {
        const cloudPayments = await getPaymentsFromFirestore(params.distributor_id);
        if (cloudPayments && cloudPayments.length > 0) {
          await http.post('/api/sync/restore-from-firestore', { payments: cloudPayments }).catch(() => {});
          payments = await http.get<Payment[]>('/api/payments', params).catch(() => cloudPayments as any);
        }
      } catch (cloudErr) {
        console.warn('[Payments Cloud Fallback] Error:', cloudErr);
      }
    }
    return payments || [];
  },

  record: async (paymentData: {
    shop_id: number;
    amount: number;
    payment_date: string;
    payment_mode: string;
    notes?: string;
    order_id?: number;
  }) => {
    return http.post<{ id: number; message: string; status?: string; payment?: any }>('/api/payments', paymentData);
  },

  approve: async (paymentId: number) => {
    return http.post<{ success: boolean; message: string; id: number; status: string }>(`/api/payments/${paymentId}/approve`, {});
  },

  reject: async (paymentId: number, reason?: string) => {
    return http.post<{ success: boolean; message: string; id: number; status: string }>(`/api/payments/${paymentId}/reject`, { reason });
  },
};

// Analytics & Reports Services
export const reportApi = {
  getDashboardMetrics: (date?: string, distributor_id?: number) => http.get<any>('/api/reports/dashboard', { date, distributor_id }),

  remindUnsubmittedShops: (distributor_id?: number) =>
    http.post<{ message: string; sentCount: number }>('/api/notifications/remind-unsubmitted', { distributor_id }),
};

// In-App Notifications Services
export const notificationApi = {
  getAll: () => http.get<Notification[]>('/api/notifications'),

  markRead: (id: number) => http.post<{ message: string }>(`/api/notifications/${id}/read`),

  markAllRead: () => http.post<{ message: string }>('/api/notifications/read-all'),
};

// Settings & Audit Trail Services
export const settingsApi = {
  get: async (distributor_id?: number) => {
    let sett = await http.get<SystemSettings>('/api/settings', distributor_id ? { distributor_id } : undefined).catch(() => null);
    const needsCloudFallback = !sett || Object.keys(sett).length === 0 || (distributor_id && !sett.distributor_upi && !sett.distributor_name);
    if (needsCloudFallback) {
      try {
        const cloudSett = await getSettingsFromFirestore(distributor_id);
        if (cloudSett && Object.keys(cloudSett).length > 0) {
          let isSuperAdmin = false;
          try {
            const currentToken = tokenStorage.get();
            const userStr = typeof localStorage !== 'undefined' ? localStorage.getItem('doodh_user') : null;
            let cachedUser = userStr ? JSON.parse(userStr) : null;
            if ((!cachedUser || cachedUser._token !== currentToken) && currentToken) {
              const me = await http.get<User>('/api/auth/me').catch(() => null);
              if (me) {
                cachedUser = { ...me, _token: currentToken };
                if (typeof localStorage !== 'undefined') {
                  localStorage.setItem('doodh_user', JSON.stringify(cachedUser));
                }
              }
            }
            isSuperAdmin = cachedUser?.role === 'superadmin';
          } catch (e) {}
          if (isSuperAdmin && (cloudSett.platform_upi_id || cloudSett.platform_qr_image || cloudSett.platform_owner_name)) {
            await http.put('/api/superadmin/platform-qr', cloudSett).catch(() => {});
          }
          if (distributor_id && (cloudSett.distributor_upi || cloudSett.distributor_qr_image)) {
            await http.put(`/api/distributor/payment-qr?distributor_id=${distributor_id}`, cloudSett).catch(() => {});
          }
          sett = { ...(cloudSett || {}), ...(sett || {}) };
        }
      } catch (e) {
        console.warn('[Firestore] Error syncing settings from cloud:', e);
      }
    }
    return sett || ({} as SystemSettings);
  },

  update: async (settingsData: Partial<SystemSettings>, distributor_id?: number) => {
    return http.put<{ message: string }>('/api/settings', {
      ...settingsData,
      ...(distributor_id ? { distributor_id } : {}),
    });
  },

  getAuditLogs: () => http.get<AuditLog[]>('/api/audit-logs'),
};

// Super Admin Platform & Distributors Management Services
export const superAdminApi = {
  getMetrics: () => http.get<SuperAdminMetrics>('/api/superadmin/metrics'),
  getDistributors: async () => {
    let list = await http.get<Distributor[]>('/api/superadmin/distributors').catch(() => []);
    const cacheKey = 'superadmin_distributors';

    if ((!list || list.length === 0) && !restoredSessionCache.has(cacheKey)) {
      restoredSessionCache.add(cacheKey);
      try {
        const [cloudDistributors, cloudShops] = await Promise.all([
          getDistributorsFromFirestore().catch(() => []),
          getShopsFromFirestore().catch(() => []),
        ]);
        if ((cloudDistributors && cloudDistributors.length > 0) || (cloudShops && cloudShops.length > 0)) {
          await http.post('/api/sync/restore-from-firestore', {
            distributors: cloudDistributors,
            shops: cloudShops,
          }).catch(() => {});
          list = await http.get<Distributor[]>('/api/superadmin/distributors').catch(() => cloudDistributors as any);
        }
      } catch (e) {
        console.warn('[SuperAdmin Cloud Fallback] Error:', e);
      }
    }

    return list || [];
  },
  createDistributor: async (data: any) => {
    const res = await http.post<{ id: number; pin: string; message: string; distributor?: any }>('/api/superadmin/distributors', data);
    try {
      if (typeof localStorage !== 'undefined' && data?.mobile) {
        const cleanMob = String(data.mobile).replace(/\D/g, '');
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
    return res;
  },
  updateDistributor: async (id: number, data: any) => {
    return http.put<{ message: string; distributor?: any }>(`/api/superadmin/distributors/${id}`, data);
  },
  deleteDistributor: async (id: number | string, mobile?: string, firestoreId?: string) => {
    const qParam = mobile ? `?mobile=${encodeURIComponent(mobile)}` : '';
    let res = { message: 'Distributor deleted' };
    try {
      const fb = await import('./firebase.ts');
      await Promise.all([
        http.delete<{ message: string }>(`/api/superadmin/distributors/${id}${qParam}`).then((r) => { res = r; }).catch(() => {}),
        fb.deleteDistributorFromFirestore(id, mobile, firestoreId).catch(() => {}),
      ]);
    } catch (e) {
      // Backend error fallback
    }

    try {
      if (typeof localStorage !== 'undefined') {
        const cleanMob = mobile ? String(mobile).replace(/\D/g, '') : '';
        const mob10 = cleanMob.slice(-10);
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

    return res;
  },
  getSubscriptionPayments: async () => {
    try {
      const cloudPayments = await getSubscriptionPaymentsFromFirestore().catch(() => []);
      if (cloudPayments && cloudPayments.length > 0) {
        await http.post('/api/sync/restore-from-firestore', {
          subscription_payments: cloudPayments,
        }).catch(() => {});
      }
    } catch (e) {}
    return http.get<SubscriptionPayment[]>('/api/superadmin/subscription-payments');
  },
  approveSubscriptionPayment: async (id: number) => {
    return http.post<{ success: boolean; message: string; distributor_id?: number; payment?: any; distributor?: any; new_renewal_date?: string }>(
      `/api/superadmin/subscription-payments/${id}/approve`
    );
  },
  rejectSubscriptionPayment: async (id: number, reason?: string) => {
    return http.post<{ success: boolean; message: string; distributor_id?: number; payment?: any; distributor?: any }>(
      `/api/superadmin/subscription-payments/${id}/reject`,
      { reason }
    );
  },
  recordPayment: async (distributorId: number, data: any) => {
    return http.post<{ message: string; renewal_date?: string; distributor_id?: number; payment?: any; distributor?: any }>(
      `/api/superadmin/distributors/${distributorId}/payments`,
      data
    );
  },
  impersonate: (id: number) =>
    http.post<{ token: string; user: User }>(`/api/superadmin/impersonate/${id}`),
  getMonitoring: (id: number) =>
    http.get<DistributorMonitoringData>(`/api/superadmin/distributors/${id}/monitoring`),
  setStatus: async (id: number, status: SubscriptionStatus, mobile?: string, firestore_id?: string) => {
    return http.patch<{ message: string; subscription_status: SubscriptionStatus; id?: number; mobile?: string }>(
      `/api/superadmin/distributors/${id}/status`,
      { status, mobile, firestore_id }
    );
  },
  resetPin: async (id: number, pin: string) => {
    const res = await http.post<{ success: boolean; message: string }>(`/api/superadmin/distributors/${id}/reset-pin`, { pin });
    return res;
  },
  getNetworkOrders: (date?: string, distributor_id?: number | string) =>
    http.get<SuperAdminNetworkOrdersResponse>('/api/superadmin/network-orders', { date, distributor_id }),
  updateSubscriptionPlan: async (id: string, data: any) => {
    return http.put<any>(`/api/superadmin/subscription-plans/${id}`, data);
  },
  createSubscriptionPlan: async (data: any) => {
    return http.post<any>('/api/superadmin/subscription-plans', data);
  },
};

// -------------------------------------------------------------
// 7. CONSOLIDATED API OBJECT (FULL BACKWARD & FORWARD COMPATIBILITY)
// -------------------------------------------------------------
export const api = {
  // HTTP Client & Storage Direct Access
  http,
  token: tokenStorage,

  // Domain Services Namespaced
  authService: authApi,
  productService: productApi,
  orderService: orderApi,
  demandService: demandApi,
  shopService: shopApi,
  paymentService: paymentApi,
  reportService: reportApi,
  notificationService: notificationApi,
  settingsService: settingsApi,
  superAdminService: superAdminApi,

  // Flat method bindings for seamless component consumption
  login: authApi.login,
  registerShop: authApi.registerShop,
  changePassword: authApi.changePassword,
  getMe: authApi.getMe,
  sendOtp: authApi.sendOtp,
  logout: authApi.logout,

  getProducts: productApi.getAll,
  createProduct: productApi.create,
  updateProduct: productApi.update,
  deleteProduct: productApi.delete,
  setCustomPrice: productApi.setCustomPrice,
  updateSubscriptionPlan: superAdminApi.updateSubscriptionPlan,
  createSubscriptionPlan: superAdminApi.createSubscriptionPlan,

  getOrders: orderApi.getAll,
  getOrder: orderApi.getById,
  createOrder: orderApi.create,
  updateOrder: orderApi.update,
  cancelOrder: orderApi.cancel,
  updateOrderStatus: orderApi.updateStatus,
  repeatLastOrder: orderApi.repeatLast,
  saveRegularOrder: orderApi.saveRegularDefaults,
  getRegularDefaults: orderApi.getRegularDefaults,

  getConsolidatedDemand: demandApi.getConsolidated,

  getNextShopCode: shopApi.getNextShopCode,
  getShops: shopApi.getAll,
  createShop: shopApi.create,
  updateShop: shopApi.update,
  deleteShop: shopApi.delete,
  getShopLedger: shopApi.getLedger,
  resetShopPin: shopApi.resetPin,

  getPayments: paymentApi.getAll,
  recordPayment: paymentApi.record,
  approvePayment: paymentApi.approve,
  rejectPayment: paymentApi.reject,

  getDashboardMetrics: reportApi.getDashboardMetrics,
  remindUnsubmittedShops: reportApi.remindUnsubmittedShops,

  getNotifications: notificationApi.getAll,
  markNotificationRead: notificationApi.markRead,
  markAllNotificationsRead: notificationApi.markAllRead,

  getSettings: settingsApi.get,
  updateSettings: (settingsData: Partial<SystemSettings>, distributorId?: number) =>
    settingsApi.update(settingsData, distributorId),
  getAuditLogs: settingsApi.getAuditLogs,

  // Super Admin Platform methods
  getSuperAdminMetrics: superAdminApi.getMetrics,
  getDistributors: superAdminApi.getDistributors,
  createDistributor: superAdminApi.createDistributor,
  updateDistributor: superAdminApi.updateDistributor,
  deleteDistributor: superAdminApi.deleteDistributor,
  recordDistributorPayment: superAdminApi.recordPayment,
  getSubscriptionPayments: superAdminApi.getSubscriptionPayments,
  approveSubscriptionPayment: superAdminApi.approveSubscriptionPayment,
  rejectSubscriptionPayment: superAdminApi.rejectSubscriptionPayment,
  impersonateDistributor: superAdminApi.impersonate,
  getDistributorMonitoring: superAdminApi.getMonitoring,
  setDistributorStatus: superAdminApi.setStatus,
  resetDistributorPin: superAdminApi.resetPin,
  getSuperAdminNetworkOrders: superAdminApi.getNetworkOrders,

  // Distributor Subscription Self-Service
  getMySubscription: async (distributorId?: number) => {
    let res = await http.get<any>(`/api/distributor/subscription${distributorId ? `?distributor_id=${distributorId}` : ''}`);
    const targetDistId = distributorId || res?.distributor?.id;
    const distMobile = res?.distributor?.mobile ? String(res.distributor.mobile).replace(/\D/g, '').slice(-10) : '';
    const cacheKey = `sub_payments_${targetDistId || 'current'}`;

    if (targetDistId && (!res?.payments || res.payments.length === 0) && !restoredSessionCache.has(cacheKey)) {
      restoredSessionCache.add(cacheKey);
      try {
        const cloudPayments = await getSubscriptionPaymentsFromFirestore().catch(() => []);
        const myCloudPayments = cloudPayments.filter((p: any) => {
          const pDistId = Number(p.distributor_id);
          const pMob = p.distributor_mobile ? String(p.distributor_mobile).replace(/\D/g, '').slice(-10) : '';
          return pDistId === Number(targetDistId) || (distMobile && pMob && pMob === distMobile);
        });

        if (myCloudPayments && myCloudPayments.length > 0) {
          const normalizedPayments = myCloudPayments.map((p: any) => ({
            ...p,
            distributor_id: targetDistId,
          }));

          await http.post('/api/sync/restore-from-firestore', {
            subscription_payments: normalizedPayments,
          }).catch(() => {});

          const refreshed = await http.get<any>(`/api/distributor/subscription${distributorId ? `?distributor_id=${distributorId}` : ''}`).catch(() => null);
          if (refreshed && refreshed.payments && refreshed.payments.length > 0) {
            res = refreshed;
          } else if (res) {
            res.payments = normalizedPayments;
          }
        }
      } catch (e) {}
    }
    return res;
  },
  getSubscriptionPlans: async (): Promise<SubscriptionPlan[]> => {
    let list = await http.get<SubscriptionPlan[]>('/api/subscription/plans').catch(() => []);
    const cacheKey = 'subscription_plans';

    if ((!list || list.length === 0) && !restoredSessionCache.has(cacheKey)) {
      restoredSessionCache.add(cacheKey);
      try {
        const cloudPlans = await getSubscriptionPlansFromFirestore();
        if (cloudPlans && cloudPlans.length > 0) {
          await http.post('/api/sync/restore-plans', { plans: cloudPlans }).catch(() => {});
          list = await http.get<any[]>('/api/subscription/plans').catch(() => list);
        }
      } catch (e) {
        console.warn('[Firestore] Error syncing plans from cloud:', e);
      }
    }
    return list || [];
  },
  renewSubscription: async (data: {
    plan_name: string;
    duration_months: number;
    amount?: number;
    payment_mode?: string;
    reference_no?: string;
    notes?: string;
    distributor_id?: number;
  }) => {
    return http.post<any>('/api/distributor/subscription/renew', data);
  },

  // QR Code & UPI Management
  updatePlatformQr: (data: { platform_upi_id?: string; platform_qr_image?: string; platform_owner_name?: string }) =>
    http.put<any>('/api/superadmin/platform-qr', data),
  updateDistributorQr: (
    data: { distributor_upi?: string; distributor_qr_image?: string },
    distributorId?: number
  ) => {
    const q = distributorId ? `?distributor_id=${distributorId}` : '';
    return http.put<any>(`/api/distributor/payment-qr${q}`, data);
  },

  // Retailer Distributor Information
  getMyDistributor: () => http.get<RetailerDistributorInfo>('/api/retailer/my-distributor'),
  syncFromFirestore: (payload: any) => http.post('/api/sync/restore-from-firestore', payload),
};

export default api;