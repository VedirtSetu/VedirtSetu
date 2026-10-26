import React, { useState, useEffect, useRef } from 'react';
import { User, Order as OrderType, SystemSettings, OrderStatus } from '../../types/index.ts';
import {
  Language,
  translations,
  formatCurrency,
  getStatusName,
  getProductName,
  getUnitName,
  getRouteName,
  getShopName,
  getAreaName,
} from '../../utils/i18n.ts';
import { api } from '../../services/api.ts';
import { subscribeToFirestoreOrders } from '../../services/firebase.ts';
import { Order } from './Order.tsx';
import {
  ShoppingBag,
  RotateCcw,
  CheckCircle2,
  Clock,
  Package,
  Truck,
  XCircle,
  FileText,
  CreditCard,
  Store,
  ChevronRight,
  AlertCircle,
  Calendar,
  MessageCircle,
  Printer,
  QrCode,
  Building2,
} from 'lucide-react';
import { CutoffBadge } from './CutoffBadge.tsx';
import { UpiPaymentModal } from './UpiPaymentModal.tsx';
import { RetailerDistributorView } from './RetailerDistributorView.tsx';
import { OrderTrendsCard } from './OrderTrendsCard.tsx';
import { PushNotificationPrompt } from './PushNotificationPrompt.tsx';
import { notifyOrderStatusChange } from '../../services/pushNotification.ts';
import { formatOrderWhatsAppMessage, openWhatsAppShare } from '../../utils/whatsapp.ts';

interface RetailerDashboardProps {
  user: User;
  lang: Language;
}

export const RetailerDashboard: React.FC<RetailerDashboardProps> = ({ user, lang }) => {
  const t = translations[lang];
  const [activeTab, setActiveTab] = useState<'home' | 'new_order' | 'history' | 'ledger' | 'distributor' | 'profile'>('home');
  const [orders, setOrders] = useState<OrderType[]>([]);
  const [todayOrder, setTodayOrder] = useState<OrderType | null>(null);
  const [editingOrder, setEditingOrder] = useState<OrderType | null>(null);
  const [selectedOrderDetails, setSelectedOrderDetails] = useState<OrderType | null>(null);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [ledgerSummary, setLedgerSummary] = useState<{ total_billed: number; total_paid: number; total_pending?: number; pending_orders_amount?: number; balance: number } | null>(null);
  const [ledgerOrders, setLedgerOrders] = useState<any[]>([]);
  const [pendingLedgerOrders, setPendingLedgerOrders] = useState<any[]>([]);
  const [ledgerPayments, setLedgerPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionSuccessMsg, setActionSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [orderToCancel, setOrderToCancel] = useState<number | null>(null);
  const [showUpiModal, setShowUpiModal] = useState(false);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // Status tracking refs for instant push alert delivery upon status change
  const prevOrderStatusesRef = useRef<Map<number, string>>(new Map());
  const isFirstLoadRef = useRef(true);

  const checkAndNotifyStatusChanges = (newOrders: OrderType[]) => {
    if (!newOrders || newOrders.length === 0) return;

    newOrders.forEach((ord) => {
      if (!ord || !ord.id || !ord.status) return;
      const prevStatus = prevOrderStatusesRef.current.get(ord.id);

      // Trigger push notification if status transitioned
      if (!isFirstLoadRef.current && prevStatus && prevStatus !== ord.status) {
        notifyOrderStatusChange({
          orderId: ord.id,
          orderNumber: ord.order_number,
          newStatus: ord.status,
          oldStatus: prevStatus,
          shopName: user.shop_name,
          totalAmount: ord.total_amount,
          lang: lang === 'hi' ? 'hi' : 'en',
        });
      }

      prevOrderStatusesRef.current.set(ord.id, ord.status);
    });

    isFirstLoadRef.current = false;
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [orderList, sett] = await Promise.all([
        api.getOrders(user.shop_id ? { shop_id: user.shop_id } : undefined),
        api.getSettings(user.distributor_id).catch(() => null),
      ]);
      setOrders(orderList);
      checkAndNotifyStatusChanges(orderList);
      if (sett) setSettings(sett);

      const tomorrowStr = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const yesterdayStr = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

      // Look for today's order, or an active pending/confirmed order for tomorrow or today
      const today = orderList.find((o) => o.order_date === todayStr && o.status !== 'Cancelled')
        || orderList.find((o) => o.order_date === tomorrowStr && o.status !== 'Cancelled')
        || orderList.find((o) => o.order_date === yesterdayStr && (o.status === 'Pending' || o.status === 'Confirmed' || o.status === 'Packed'));
      setTodayOrder(today || null);

      if (user.shop_id) {
        const ledger = await api.getShopLedger(user.shop_id).catch(() => null);
        if (ledger) {
          setLedgerSummary(ledger.summary);
          setLedgerOrders(Array.isArray(ledger.orders) ? ledger.orders : []);
          setPendingLedgerOrders(Array.isArray(ledger.pending_orders) ? ledger.pending_orders : []);
          setLedgerPayments(Array.isArray(ledger.payments) ? ledger.payments : []);
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || (lang === 'hi' ? 'डेटा लोड नहीं हो सका' : 'Failed to load data'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    let debounceTimer: any = null;
    // Listen to Firestore cloud orders so edits/deliveries by distributor appear in real-time
    const unsubscribe = subscribeToFirestoreOrders(
      (cloudOrders) => {
        if (cloudOrders && cloudOrders.length > 0) {
          const myOrders = cloudOrders.filter(
            (o: any) => o && (!user?.shop_id || Number(o.shop_id) === Number(user.shop_id))
          );
          if (myOrders.length > 0) {
            myOrders.forEach((co: any) => {
              const ordId = Number(co.id);
              if (ordId && co.status) {
                const prev = prevOrderStatusesRef.current.get(ordId);
                if (prev && prev !== co.status) {
                  notifyOrderStatusChange({
                    orderId: ordId,
                    orderNumber: co.order_number || String(ordId),
                    newStatus: co.status,
                    oldStatus: prev,
                    shopName: user.shop_name,
                    totalAmount: co.total_amount,
                    lang: lang === 'hi' ? 'hi' : 'en',
                  });
                  prevOrderStatusesRef.current.set(ordId, co.status);
                }
              }
            });
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              fetchData();
            }, 300);
          }
        }
      },
      undefined,
      user?.shop_id
    );

    return () => {
      clearTimeout(debounceTimer);
      if (unsubscribe) unsubscribe();
    };
  }, [user, lang]);

  // 1-Tap Repeat Previous Order
  const handleRepeatLastOrder = async () => {
    if (todayOrder) {
      setErrorMsg(t.orderAlreadyPlaced);
      setTimeout(() => setErrorMsg(''), 4000);
      return;
    }
    setErrorMsg('');
    setActionSuccessMsg('');
    try {
      const { items } = await api.repeatLastOrder();
      const res = await api.createOrder({ items });

      setActionSuccessMsg(
        lang === 'hi'
          ? `पिछला ऑर्डर सफलतापूर्वक दोहराया गया! ऑर्डर संख्या: ${res.order_number}`
          : `Repeated previous order successfully! Order #${res.order_number}`
      );
      fetchData();
    } catch (err: any) {
      setErrorMsg(err.message || (lang === 'hi' ? 'पिछला ऑर्डर दोहराने में विफल' : 'Failed to repeat order'));
    }
  };

  const handleConfirmCancelOrder = async () => {
    if (!orderToCancel) return;
    try {
      await api.cancelOrder(orderToCancel, lang === 'hi' ? 'दुकानदार द्वारा रद्दीकरण' : 'Cancelled by shopkeeper');

      setActionSuccessMsg(t.orderCancelledSuccess);
      setOrderToCancel(null);
      fetchData();
    } catch (err: any) {
      setErrorMsg(err.message || t.error);
      setOrderToCancel(null);
    }
  };

  const renderStatusBadge = (status: OrderStatus) => {
    const map: Record<OrderStatus, { bg: string; icon: any }> = {
      Pending: { bg: 'bg-amber-100 text-amber-800 border-amber-300', icon: Clock },
      Confirmed: { bg: 'bg-blue-100 text-blue-800 border-blue-300', icon: CheckCircle2 },
      Packed: { bg: 'bg-indigo-100 text-indigo-800 border-indigo-300', icon: Package },
      'Partially Delivered': { bg: 'bg-purple-100 text-purple-800 border-purple-300', icon: Truck },
      Delivered: { bg: 'bg-emerald-100 text-emerald-800 border-emerald-300', icon: CheckCircle2 },
      Cancelled: { bg: 'bg-red-100 text-red-800 border-red-300', icon: XCircle },
    };
    const conf = map[status] || { bg: 'bg-slate-100 text-slate-800 border-slate-300', icon: Clock };
    const Icon = conf.icon;
    return (
      <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black border ${conf.bg}`}>
        <Icon className="w-3.5 h-3.5" />
        <span>{getStatusName(status, lang)}</span>
      </span>
    );
  };

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-6 py-4 space-y-4">
      {/* Success Notification Banner */}
      {actionSuccessMsg && (
        <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs sm:text-sm font-bold flex items-center justify-between shadow-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
            <span>{actionSuccessMsg}</span>
          </div>
          <button onClick={() => setActionSuccessMsg('')} className="text-emerald-700 font-bold hover:underline">
            ✕
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="p-4 rounded-2xl bg-red-50 border border-red-300 text-red-800 text-xs sm:text-sm font-bold flex items-center justify-between shadow-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg('')} className="text-red-700 font-bold hover:underline">
            ✕
          </button>
        </div>
      )}

      {/* Instant Push Notification Permission Banner & Status */}
      <PushNotificationPrompt lang={lang} />

      {/* Navigation Tabs Bar */}
      <div className="flex items-center gap-1.5 p-1.5 bg-white rounded-2xl border border-slate-200 overflow-x-auto shadow-xs no-scrollbar">
        <button
          onClick={() => {
            setActiveTab('home');
            setEditingOrder(null);
          }}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition ${
            activeTab === 'home' && !editingOrder
              ? 'bg-emerald-800 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          }`}
        >
          <Store className="w-4 h-4" />
          <span>{t.dashboard}</span>
        </button>

        <button
          onClick={() => {
            setEditingOrder(null);
            setActiveTab('new_order');
          }}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition ${
            activeTab === 'new_order'
              ? 'bg-emerald-800 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          }`}
        >
          <ShoppingBag className="w-4 h-4" />
          <span>{t.newOrder}</span>
        </button>

        <button
          onClick={() => {
            setEditingOrder(null);
            setActiveTab('history');
          }}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition ${
            activeTab === 'history'
              ? 'bg-emerald-800 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>{t.myOrders}</span>
        </button>

        <button
          onClick={() => {
            setEditingOrder(null);
            setActiveTab('ledger');
          }}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition ${
            activeTab === 'ledger'
              ? 'bg-emerald-800 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          }`}
        >
          <CreditCard className="w-4 h-4" />
          <span>{t.outstandingLedger}</span>
        </button>

        <button
          onClick={() => {
            setEditingOrder(null);
            setActiveTab('distributor');
          }}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition ${
            activeTab === 'distributor'
              ? 'bg-emerald-800 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          }`}
        >
          <Building2 className="w-4 h-4 text-emerald-600" />
          <span>{lang === 'hi' ? '🏢 मेरा वितरक' : '🏢 My Distributor'}</span>
        </button>

        <button
          onClick={() => {
            setEditingOrder(null);
            setActiveTab('profile');
          }}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition ${
            activeTab === 'profile'
              ? 'bg-emerald-800 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          }`}
        >
          <Store className="w-4 h-4" />
          <span>{t.shopProfile}</span>
        </button>
      </div>

      {/* TAB: NEW OR EDIT ORDER FORM */}
      {(activeTab === 'new_order' || editingOrder) && (
        <Order
          lang={lang}
          existingOrder={editingOrder}
          settings={settings}
          onSuccess={(id) => {
            setActionSuccessMsg(
              lang === 'hi'
                ? `ऑर्डर सफलतापूर्वक दर्ज हो गया! (ऑर्डर संख्या #${id})`
                : `Order saved successfully! (#${id})`
            );
            setEditingOrder(null);
            setActiveTab('home');
            fetchData();
          }}
          onCancel={() => {
            setEditingOrder(null);
            setActiveTab('home');
          }}
        />
      )}

      {/* TAB: DASHBOARD HOME */}
      {activeTab === 'home' && !editingOrder && (
        <div className="space-y-4">
          {/* Shop Header Banner */}
          <div className="p-4 sm:p-5 rounded-3xl bg-gradient-to-tr from-emerald-900 to-emerald-700 text-white shadow-lg flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 text-emerald-200 text-[11px] font-bold mb-1 border border-white/10">
                <Store className="w-3.5 h-3.5" />
                <span>{user.shop_code}</span>
              </div>
              <h1 className="text-xl sm:text-2xl font-black">{getShopName(user.shop_name, lang)}</h1>
              <p className="text-xs text-emerald-100 mt-0.5">{user.name} • {user.mobile}</p>
            </div>

            {/* Quick Balance Badge */}
            {ledgerSummary && (
              <div className="bg-white/10 backdrop-blur-md px-4 py-3 rounded-2xl border border-white/20 text-right">
                <div className="text-[10px] text-emerald-200 font-bold uppercase tracking-wider">
                  {t.outstandingAmount}
                </div>
                <div className={`text-xl font-black ${ledgerSummary.balance > 0 ? 'text-amber-300' : 'text-emerald-100'}`}>
                  {formatCurrency(ledgerSummary.balance)}
                </div>
              </div>
            )}
          </div>

          {/* Today's Order Status Card */}
          <div className="p-5 sm:p-6 rounded-3xl bg-white border border-emerald-100 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between border-b border-slate-100 pb-3 gap-2">
              <div className="flex items-center gap-2">
                <Calendar className="w-5 h-5 text-emerald-700" />
                <h2 className="font-extrabold text-base text-slate-800">{t.todayOrderStatus}</h2>
              </div>
              <div className="flex items-center gap-2">
                <CutoffBadge
                  cutoffTime={settings?.cutoff_time || '20:00'}
                  allowLate={settings?.allow_late_orders ?? true}
                  lang={lang}
                />
                <span className="text-xs font-bold text-slate-500 hidden sm:inline">{todayStr}</span>
              </div>
            </div>

            {loading && !todayOrder ? (
              <div className="p-6 rounded-2xl bg-slate-50 border border-slate-200 animate-pulse space-y-3">
                <div className="flex justify-between items-center">
                  <div className="h-4 w-28 bg-slate-200 rounded-md" />
                  <div className="h-6 w-20 bg-slate-200 rounded-full" />
                </div>
                <div className="h-8 w-44 bg-slate-200 rounded-lg" />
                <div className="h-16 w-full bg-slate-100 rounded-xl" />
              </div>
            ) : todayOrder ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 p-4 rounded-2xl bg-emerald-50/60 border border-emerald-200">
                  <div>
                    <div className="text-xs text-slate-500 font-medium">{t.orderNumber}:</div>
                    <div className="font-black text-sm sm:text-base text-slate-900">{todayOrder.order_number}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 font-medium">{t.totalAmount}:</div>
                    <div className="font-black text-lg text-emerald-900">{formatCurrency(todayOrder.total_amount)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 font-medium mb-0.5">{t.actions}:</div>
                    {renderStatusBadge(todayOrder.status)}
                  </div>
                </div>

                {/* Items Summary */}
                {todayOrder.items && todayOrder.items.length > 0 && (
                  <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200">
                    <div className="text-xs font-bold text-slate-700 mb-2">{t.orderedItems}</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                      {todayOrder.items.map((it, idx) => (
                        <div key={`today-it-${it.id || it.product_id || idx}-${idx}`} className="flex justify-between items-center bg-white p-2 rounded-xl border border-slate-200">
                          <span className="font-bold text-slate-800">
                            {getProductName(it, lang)}
                          </span>
                          <span className="font-black text-emerald-800">
                            {it.ordered_quantity} {getUnitName(it.unit || '', lang)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions for today's order */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {todayOrder.status === 'Pending' && (
                    <>
                      <button
                        onClick={() => setEditingOrder(todayOrder)}
                        className="px-4 py-2.5 rounded-xl border border-emerald-600 bg-emerald-50 text-emerald-800 font-bold text-xs hover:bg-emerald-100 transition"
                      >
                        {t.editOrder}
                      </button>
                      <button
                        onClick={() => setOrderToCancel(todayOrder.id)}
                        className="px-4 py-2.5 rounded-xl border border-red-200 bg-red-50 text-red-700 font-bold text-xs hover:bg-red-100 transition"
                      >
                        {t.cancelOrder}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => {
                      const msg = formatOrderWhatsAppMessage(todayOrder, user.shop_name, lang);
                      openWhatsAppShare(msg);
                    }}
                    className="px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs transition active:scale-95"
                  >
                    <MessageCircle className="w-4 h-4 fill-white" />
                    <span>{lang === 'hi' ? 'व्हाट्सएप रसीद' : 'WhatsApp Slip'}</span>
                  </button>
                  <button
                    onClick={() => setSelectedOrderDetails(todayOrder)}
                    className="px-4 py-2.5 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs hover:bg-slate-200 transition"
                  >
                    {t.viewDetails}
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center mx-auto">
                  <Clock className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-black text-slate-800 text-base">{t.noOrdersToday}</h3>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
                    {t.noOrdersTodaySub.replace('{cutoff}', settings?.cutoff_time || '20:00')}
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                  <button
                    onClick={() => setActiveTab('new_order')}
                    className="px-6 py-3 rounded-2xl bg-emerald-700 hover:bg-emerald-800 active:scale-95 text-white font-extrabold text-sm shadow-md transition flex items-center gap-2"
                  >
                    <ShoppingBag className="w-4 h-4" />
                    <span>{t.newOrder}</span>
                  </button>

                  <button
                    onClick={handleRepeatLastOrder}
                    className="px-5 py-3 rounded-2xl border-2 border-emerald-700 text-emerald-800 hover:bg-emerald-50 active:scale-95 font-bold text-sm transition flex items-center gap-2"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>{t.repeatLastOrder}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Quick Repeat Last Order Card (if no order today) */}
          {!todayOrder && orders.length > 0 && (
            <div className="p-4 sm:p-5 rounded-3xl bg-amber-50/70 border border-amber-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-extrabold text-amber-900">
                  <RotateCcw className="w-4 h-4 text-amber-700" />
                  <span>{t.repeatLastOrder}</span>
                </div>
                <p className="text-xs text-amber-800/80 mt-0.5">
                  {t.repeatDesc}
                </p>
              </div>

              <button
                onClick={handleRepeatLastOrder}
                className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-xs shadow-xs transition"
              >
                {t.repeatLastOrder}
              </button>
            </div>
          )}

          {/* 30-Day Order Volume Trends Card using Recharts */}
          <OrderTrendsCard orders={orders} lang={lang} />

          {/* Recent Orders Summary */}
          <div className="p-4 sm:p-5 rounded-3xl bg-white border border-slate-200 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
              <h3 className="font-extrabold text-sm text-slate-800">{t.recentOrders}</h3>
              <button
                onClick={() => setActiveTab('history')}
                className="text-xs font-bold text-emerald-700 hover:underline flex items-center gap-1"
              >
                <span>{t.viewAll}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="divide-y divide-slate-100">
              {orders.slice(0, 3).map((o, idx) => (
                <div
                  key={`ret-recent-ord-${o.id ?? idx}-${idx}`}
                  onClick={() => setSelectedOrderDetails(o)}
                  className="py-3 flex items-center justify-between cursor-pointer hover:bg-slate-50 px-2 rounded-xl transition"
                >
                  <div>
                    <div className="font-bold text-xs sm:text-sm text-slate-800">{o.order_number}</div>
                    <div className="text-[11px] text-slate-500">{o.order_date}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="font-extrabold text-xs sm:text-sm text-emerald-900">
                      {formatCurrency(o.total_amount)}
                    </div>
                    {renderStatusBadge(o.status)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB: ORDER HISTORY */}
      {activeTab === 'history' && !editingOrder && (
        <div className="space-y-4">
          {/* Visual Order Volume Trends Analytics */}
          <OrderTrendsCard orders={orders} lang={lang} />

          <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
            <h2 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
              <FileText className="w-5 h-5 text-emerald-700" />
              <span>{t.myOrders}</span>
            </h2>

          <div className="divide-y divide-slate-100">
            {orders.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                {t.noOrdersFound}
              </div>
            ) : (
              orders.map((ord, idx) => (
                <div
                  key={`ret-history-ord-${ord.id ?? idx}-${idx}`}
                  className="py-3.5 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50 px-2 rounded-xl transition"
                >
                  <div>
                    <div className="font-black text-sm text-slate-800">{ord.order_number}</div>
                    <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                      <span>{ord.order_date}</span>
                      {ord.cutoff_status === 'late' && (
                        <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-md font-bold">
                          {t.late}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="font-black text-sm text-emerald-900">{formatCurrency(ord.total_amount)}</div>
                      <div className="text-[11px] text-slate-500">
                        {ord.items?.length || 0} {t.items}
                      </div>
                    </div>
                    {renderStatusBadge(ord.status)}
                    <button
                      onClick={() => setSelectedOrderDetails(ord)}
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100"
                      title={t.viewDetails}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      )}

      {/* TAB: SHOP LEDGER */}
      {activeTab === 'ledger' && !editingOrder && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-xs text-slate-500 font-bold">{t.totalBilled}</div>
              <div className="text-xl font-black text-slate-900 mt-1">
                {loading && !ledgerSummary ? (
                  <div className="h-7 w-24 bg-slate-100 animate-pulse rounded-lg" />
                ) : (
                  formatCurrency(ledgerSummary?.total_billed || 0)
                )}
              </div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-xs text-slate-500 font-bold">{t.totalPaid}</div>
              <div className="text-xl font-black text-emerald-700 mt-1">
                {loading && !ledgerSummary ? (
                  <div className="h-7 w-24 bg-slate-100 animate-pulse rounded-lg" />
                ) : (
                  formatCurrency(ledgerSummary?.total_paid || 0)
                )}
              </div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-xs text-slate-500 font-bold">{t.outstandingAmount}</div>
              <div className={`text-xl font-black mt-1 ${(ledgerSummary?.balance || 0) > 0 ? 'text-amber-600' : 'text-emerald-700'}`}>
                {loading && !ledgerSummary ? (
                  <div className="h-7 w-24 bg-slate-100 animate-pulse rounded-lg" />
                ) : (
                  formatCurrency(ledgerSummary?.balance || 0)
                )}
              </div>
            </div>
          </div>

          {/* Pending / Unconfirmed Orders Notice (Informs retailer that pending orders are not yet billed to ledger) */}
          {(ledgerSummary?.pending_orders_amount || 0) > 0 && (
            <div className="p-3.5 sm:p-4 rounded-2xl bg-amber-50/80 border border-amber-200 text-amber-950 flex items-center justify-between gap-3 text-xs shadow-2xs">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center shrink-0 text-amber-700">
                  <Clock className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-extrabold text-amber-900">
                    {lang === 'hi' ? 'सत्यापन लंबित ऑर्डर (अपुष्ट)' : 'Pending / Unconfirmed Orders'}
                  </div>
                  <div className="text-[11px] text-amber-800">
                    {lang === 'hi'
                      ? 'यह राशि वितरक द्वारा ऑर्डर स्वीकृत/डिलीवर होने के बाद ही बकाया खाते में जुड़ेगी।'
                      : 'This amount will be billed to your ledger only after distributor confirmation/delivery.'}
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <span className="font-black text-sm text-amber-900">
                  {formatCurrency(ledgerSummary?.pending_orders_amount || 0)}
                </span>
              </div>
            </div>
          )}

          {/* Quick Pay via UPI QR Code Banner (if balance > 0) */}
          {(ledgerSummary?.balance || 0) > 0 && (
            <div className="p-4 sm:p-5 rounded-3xl bg-gradient-to-r from-emerald-900 to-emerald-700 text-white shadow-md flex flex-wrap items-center justify-between gap-3 animate-in fade-in">
              <div className="space-y-0.5">
                <div className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-200 uppercase tracking-wider">
                  <QrCode className="w-3.5 h-3.5 text-amber-300" />
                  <span>{lang === 'hi' ? 'डिजिटल पेमेंट' : 'Digital UPI Settlement'}</span>
                </div>
                <h4 className="text-sm sm:text-base font-black">
                  {lang === 'hi' ? 'UPI QR कोड से तुरंत बकाया राशि चुकाएं' : 'Pay outstanding balance via instant UPI QR'}
                </h4>
                <p className="text-xs text-emerald-100">
                  {lang === 'hi' ? 'Google Pay, PhonePe, Paytm या किसी भी UPI ऐप से भुगतान करें' : 'Scan and pay using any UPI app on your phone'}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowUpiModal(true)}
                className="px-5 py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-sm transition active:scale-95"
              >
                <QrCode className="w-4 h-4" />
                <span>{lang === 'hi' ? 'QR कोड खोलें' : 'Open UPI QR Code'}</span>
              </button>
            </div>
          )}

          <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="font-extrabold text-sm text-slate-800">{t.transactionsHistory}</h3>
              {(ledgerSummary?.balance || 0) > 0 && (
                <button
                  type="button"
                  onClick={() => setShowUpiModal(true)}
                  className="text-xs font-bold text-emerald-700 hover:underline flex items-center gap-1"
                >
                  <QrCode className="w-3.5 h-3.5" />
                  <span>{lang === 'hi' ? 'भुगतान करें' : 'Pay Dues'}</span>
                </button>
              )}
            </div>
            <div className="divide-y divide-slate-100">
              {[
                ...(ledgerOrders.length > 0 ? ledgerOrders : orders.filter((o) => o.status !== 'Cancelled' && o.status !== 'Pending')).map((o: any) => ({
                  txType: 'order' as const,
                  id: `ord-${o.id}`,
                  label: o.order_number,
                  date: o.order_date,
                  status: o.status,
                  sub: getStatusName(o.status, lang),
                  amount: o.total_amount,
                  createdAt: o.created_at || o.order_date,
                })),
                ...(pendingLedgerOrders.length > 0 ? pendingLedgerOrders : orders.filter((o) => o.status === 'Pending')).map((po: any) => ({
                  txType: 'pending_order' as const,
                  id: `pending-ord-${po.id}`,
                  label: po.order_number,
                  date: po.order_date,
                  status: 'pending',
                  sub: lang === 'hi' ? 'सत्यापन लंबित (खाते में नहीं जुड़ा)' : 'Pending (Unbilled)',
                  amount: po.total_amount,
                  createdAt: po.created_at || po.order_date,
                })),
                ...ledgerPayments.map((p: any) => ({
                  txType: 'payment' as const,
                  id: `pay-${p.id}`,
                  label: `${lang === 'hi' ? 'भुगतान रसीद' : 'Payment'} #${p.id} (${p.payment_mode})`,
                  date: p.payment_date,
                  status: p.status,
                  sub: p.status === 'pending'
                    ? (lang === 'hi' ? 'सत्यापन लंबित' : 'Pending Verification')
                    : p.status === 'rejected'
                    ? (lang === 'hi' ? 'अस्वीकृत' : 'Rejected')
                    : (p.notes || ''),
                  amount: p.amount,
                  createdAt: p.created_at || p.payment_date,
                })),
              ]
                .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)))
                .map((tx: any, idx) => (
                  <div key={`ret-ledger-tx-${tx.id}-${idx}`} className={`py-2.5 flex items-center justify-between text-xs ${tx.txType === 'pending_order' ? 'bg-amber-50/40 px-2 rounded-lg' : ''}`}>
                    <div>
                      <span className={`font-bold ${tx.txType === 'payment' ? 'text-emerald-800' : tx.txType === 'pending_order' ? 'text-amber-950' : 'text-slate-800'}`}>
                        {tx.label}
                      </span>
                      <span className="text-slate-400 ml-2">{tx.date}</span>
                      {tx.sub && (
                        <span className={`text-[11px] ml-2 font-semibold ${tx.status === 'pending' ? 'text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200' : tx.status === 'rejected' ? 'text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200' : 'text-slate-500'}`}>
                          ({tx.sub})
                        </span>
                      )}
                    </div>
                    <span className={`font-black ${tx.txType === 'payment' ? (tx.status === 'pending' ? 'text-amber-700' : tx.status === 'rejected' ? 'text-slate-400 line-through' : 'text-emerald-700') : tx.txType === 'pending_order' ? 'text-amber-800' : 'text-slate-800'}`}>
                      {tx.txType === 'payment' ? `-${formatCurrency(tx.amount)}` : tx.txType === 'pending_order' ? `(${formatCurrency(tx.amount)})` : `+${formatCurrency(tx.amount)}`}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB: SHOP PROFILE */}
      {activeTab === 'profile' && !editingOrder && (
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
          <h2 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
            <Store className="w-5 h-5 text-emerald-700" />
            <span>{t.shopProfile}</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="text-slate-500 font-bold">{t.shopName}:</div>
              <div className="font-black text-slate-900 text-sm mt-0.5">{getShopName(user.shop_name, lang)}</div>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="text-slate-500 font-bold">{t.shopCode}:</div>
              <div className="font-black text-emerald-800 text-sm mt-0.5">{user.shop_code}</div>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="text-slate-500 font-bold">{t.ownerName}:</div>
              <div className="font-black text-slate-900 text-sm mt-0.5">{user.name}</div>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="text-slate-500 font-bold">{t.phone}:</div>
              <div className="font-black text-slate-900 text-sm mt-0.5">{user.mobile}</div>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="text-slate-500 font-bold">{t.area}:</div>
              <div className="font-black text-slate-900 text-sm mt-0.5">{getAreaName(user.area, lang)}</div>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="text-slate-500 font-bold">{t.route}:</div>
              <div className="font-black text-emerald-800 text-sm mt-0.5">{getRouteName(user.route, lang)}</div>
            </div>
          </div>
        </div>
      )}

      {/* TAB: MY DISTRIBUTOR DETAILS & CONTACT */}
      {activeTab === 'distributor' && !editingOrder && (
        <RetailerDistributorView
          lang={lang}
          onOpenPaymentModal={() => setShowUpiModal(true)}
        />
      )}

      {/* Confirmation Modal: Cancel Order */}
      {orderToCancel !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl border border-slate-200 text-center space-y-4 animate-in fade-in zoom-in-95">
            <div className="w-12 h-12 rounded-2xl bg-red-100 text-red-600 flex items-center justify-center mx-auto">
              <XCircle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-extrabold text-slate-900 text-base">
                {t.confirmCancelOrder}
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                {t.confirmCancelOrderDesc}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOrderToCancel(null)}
                className="py-2.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                {t.confirmNo}
              </button>
              <button
                type="button"
                onClick={handleConfirmCancelOrder}
                className="py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-xs"
              >
                {t.confirmYes}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order Details Modal */}
      {selectedOrderDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div>
                <div className="font-bold text-base">{selectedOrderDetails.order_number}</div>
                <div className="text-xs text-emerald-200">{selectedOrderDetails.order_date}</div>
              </div>
              <button onClick={() => setSelectedOrderDetails(null)} className="text-white hover:text-emerald-200 text-xl font-bold">
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">{t.actions}:</span>
                {renderStatusBadge(selectedOrderDetails.status)}
              </div>

              {/* Items Table */}
              <div className="border border-slate-200 rounded-2xl overflow-hidden divide-y divide-slate-100 text-xs">
                <div className="bg-slate-100 px-3 py-2 font-bold text-slate-700 flex justify-between">
                  <span>{t.productCatalog}</span>
                  <span>{t.quantity}</span>
                </div>
                {selectedOrderDetails.items?.map((it, idx) => (
                  <div key={`ret-detail-it-${it.id || it.product_id || idx}-${idx}`} className="p-3 flex justify-between items-center">
                    <div>
                      <div className="font-bold text-slate-800">
                        {getProductName(it, lang)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {it.ordered_quantity} × {formatCurrency(it.unit_price)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-extrabold text-slate-900">
                        {it.ordered_quantity} {getUnitName(it.unit || '', lang)}
                        {it.delivered_quantity > 0 && (
                          <span className="text-emerald-700 ml-1">
                            ({lang === 'hi' ? `डिलीवर: ${it.delivered_quantity}` : `Delivered: ${it.delivered_quantity}`})
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-emerald-800 font-bold">
                        {formatCurrency(it.line_total)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 flex justify-between items-center">
                <span className="text-xs font-bold text-emerald-950">{t.totalAmount}:</span>
                <span className="text-lg font-black text-emerald-900">
                  {formatCurrency(selectedOrderDetails.total_amount)}
                </span>
              </div>

              {selectedOrderDetails.notes && (
                <div className="text-xs p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="font-bold text-slate-700">{t.notes}: </span>
                  <span className="text-slate-600">{selectedOrderDetails.notes}</span>
                </div>
              )}

              {/* Action Buttons: WhatsApp Share & Print */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    const msg = formatOrderWhatsAppMessage(selectedOrderDetails, user.shop_name, lang);
                    openWhatsAppShare(msg);
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-95 shadow-xs"
                >
                  <MessageCircle className="w-4 h-4 fill-white" />
                  <span>{lang === 'hi' ? 'व्हाट्सएप पर शेयर करें' : 'Share on WhatsApp'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 font-bold text-xs flex items-center justify-center gap-1.5 transition"
                >
                  <Printer className="w-4 h-4" />
                  <span>{lang === 'hi' ? 'प्रिंट रसीद' : 'Print Slip'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* UPI QR Payment Modal */}
      {showUpiModal && (
        <UpiPaymentModal
          lang={lang}
          amount={ledgerSummary?.balance || 0}
          shopId={user.shop_id || 0}
          distributorUpi={settings?.distributor_upi || ''}
          distributorName={settings?.distributor_name || 'VedirtSetu Wholesale Distributors'}
          qrImage={settings?.distributor_qr_image}
          onClose={() => setShowUpiModal(false)}
          onPaymentSuccess={() => {
            fetchData();
            setShowUpiModal(false);
          }}
        />
      )}
    </div>
  );
};