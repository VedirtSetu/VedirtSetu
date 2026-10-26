/**
 * Push Notification Service for Retailer Order Status Updates
 * Provides browser Web Notifications and PWA Service Worker push delivery
 * with automatic permission management, sound/vibration feedback, and deduplication.
 */

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

// Key for tracking last notified status per order in sessionStorage to prevent duplicate alerts
const NOTIFIED_CACHE_KEY = 'vedirt_notified_order_statuses';

function getNotifiedCache(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(NOTIFIED_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function markOrderNotified(orderId: string | number, status: string) {
  try {
    const cache = getNotifiedCache();
    cache[`${orderId}_${status}`] = Date.now();
    sessionStorage.setItem(NOTIFIED_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function hasOrderBeenNotified(orderId: string | number, status: string): boolean {
  try {
    const cache = getNotifiedCache();
    return Boolean(cache[`${orderId}_${status}`]);
  } catch {
    return false;
  }
}

/**
 * Check if browser supports Web Notifications
 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Get current notification permission state
 */
export function getNotificationPermission(): NotificationPermissionState {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

/**
 * Request notification permission from the user
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNotificationSupported()) return 'unsupported';

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      try {
        localStorage.setItem('vedirt_push_enabled', 'true');
      } catch {}
      // Show confirmation test notification
      showBrowserNotification('🔔 नोटिफिकेशन सक्रिय! (Push Alerts Active)', {
        body: 'अब आपको ऑर्डर स्वीकृत और डिलीवरी रवाना होने पर तुरंत अलर्ट मिलेंगे।',
        tag: 'welcome-notification',
      });
    }
    return permission as NotificationPermissionState;
  } catch (err) {
    console.warn('[PushNotification] Error requesting permission:', err);
    return getNotificationPermission();
  }
}

/**
 * Core function to display a system notification via Service Worker or Notification API
 */
export async function showBrowserNotification(
  title: string,
  options: {
    body: string;
    tag?: string;
    icon?: string;
    url?: string;
    requireInteraction?: boolean;
    vibrate?: number[];
  }
): Promise<boolean> {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }

  const notificationOptions: NotificationOptions = {
    body: options.body,
    icon: options.icon || '/icon.svg',
    badge: '/icon.svg',
    tag: options.tag || `order-alert-${Date.now()}`,
    data: { url: options.url || '/' },
    requireInteraction: options.requireInteraction ?? false,
    ...((options.vibrate || [200, 100, 200]) ? { vibrate: options.vibrate || [200, 100, 200] } : {}),
  };

  // 1. Try displaying via Active Service Worker (required on Android and preferred in PWA)
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      if (registration && 'showNotification' in registration) {
        await registration.showNotification(title, notificationOptions);
        return true;
      }
    } catch (swErr) {
      console.warn('[PushNotification] ServiceWorker notification failed, falling back:', swErr);
    }
  }

  // 2. Fallback to standard window.Notification constructor
  try {
    const n = new Notification(title, notificationOptions);
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch (err) {
    console.warn('[PushNotification] window.Notification failed:', err);
    return false;
  }
}

/**
 * Trigger an instant order status update push notification for retailers.
 * Handles Confirmed, Packed (Dispatched), Delivered, Partially Delivered, and Cancelled states.
 */
export function notifyOrderStatusChange(params: {
  orderId: number | string;
  orderNumber: string;
  newStatus: string;
  oldStatus?: string;
  shopName?: string;
  totalAmount?: number;
  lang?: 'hi' | 'en';
  force?: boolean;
}): boolean {
  const { orderId, orderNumber, newStatus, shopName, totalAmount, lang = 'hi', force = false } = params;

  if (!orderId || !newStatus) return false;

  // Deduplication check
  if (!force && hasOrderBeenNotified(orderId, newStatus)) {
    return false;
  }

  const isHi = lang === 'hi';
  const shopLabel = shopName ? `${shopName}: ` : '';

  let title = '';
  let body = '';

  switch (newStatus) {
    case 'Confirmed':
      title = isHi
        ? `✅ ऑर्डर स्वीकृत! #${orderNumber}`
        : `✅ Order Confirmed! #${orderNumber}`;
      body = isHi
        ? `${shopLabel}वितरक ने आपका आज का ऑर्डर स्वीकृत कर लिया है। समय पर डिलीवरी होगी।`
        : `${shopLabel}Your order #${orderNumber} has been confirmed by the distributor.`;
      break;

    case 'Packed':
      title = isHi
        ? `🚚 ऑर्डर तैयार व रवाना! #${orderNumber}`
        : `🚚 Order Dispatched! #${orderNumber}`;
      body = isHi
        ? `${shopLabel}ऑर्डर पैक होकर डिलीवरी वाहन में लोड हो चुका है। जल्द ही आपकी दुकान पर पहुंचेगा।`
        : `${shopLabel}Order #${orderNumber} is packed and on the way with the delivery vehicle.`;
      break;

    case 'Partially Delivered':
      title = isHi
        ? `📦 आंशिक डिलीवरी प्राप्त: #${orderNumber}`
        : `📦 Partial Delivery: #${orderNumber}`;
      body = isHi
        ? `${shopLabel}सामग्री डिलीवर हो गई है। लेज़र में वास्तविक डिलीवरी राशि दर्ज की गई है।`
        : `${shopLabel}Order #${orderNumber} items partially delivered. Ledger balance adjusted.`;
      break;

    case 'Delivered':
      title = isHi
        ? `🎉 ऑर्डर डिलीवर हो गया! #${orderNumber}`
        : `🎉 Order Delivered! #${orderNumber}`;
      body = isHi
        ? `${shopLabel}सफलतापूर्वक डिलीवर! कुल बिल राशि: ₹${totalAmount || ''}। आपके खाते में दर्ज।`
        : `${shopLabel}Order #${orderNumber} (₹${totalAmount || ''}) has been delivered successfully.`;
      break;

    case 'Cancelled':
      title = isHi
        ? `⚠️ ऑर्डर रद्द हुआ: #${orderNumber}`
        : `⚠️ Order Cancelled: #${orderNumber}`;
      body = isHi
        ? `${shopLabel}ऑर्डर #${orderNumber} रद्द कर दिया गया है। अधिक विवरण हेतु ऐप देखें।`
        : `${shopLabel}Order #${orderNumber} has been cancelled. Tap to review details.`;
      break;

    default:
      return false;
  }

  markOrderNotified(orderId, newStatus);

  showBrowserNotification(title, {
    body,
    tag: `order-status-${orderId}-${newStatus}`,
    url: '/',
    requireInteraction: newStatus === 'Packed' || newStatus === 'Delivered',
  });

  return true;
}
