import React, { useState, useEffect, useMemo } from 'react';
import { User, Shop, Product, Order, SystemSettings, OrderStatus, AuditLog, Payment } from '../../types/index.ts';
import {
  Language,
  translations,
  formatCurrency,
  getStatusName,
  getCutoffStatusName,
  getProductName,
  getUnitName,
  getRouteName,
  getCategoryName,
  getPaymentModeName,
  getShopName,
  getAreaName,
} from '../../utils/i18n.ts';
import { api } from '../../services/api.ts';
import {
  subscribeToFirestoreOrders,
} from '../../services/firebase.ts';
import {
  LayoutDashboard,
  ClipboardList,
  Layers,
  Store,
  Package,
  Truck,
  CreditCard,
  BarChart3,
  Settings,
  Search,
  Plus,
  Edit3,
  CheckCircle2,
  Clock,
  Printer,
  Copy,
  Download,
  Send,
  AlertTriangle,
  Check,
  Calendar,
  Trash2,
  MessageCircle,
  Zap,
  KeyRound,
  Upload,
  QrCode,
} from 'lucide-react';
import { formatOrderWhatsAppMessage, openWhatsAppShare } from '../../utils/whatsapp.ts';
import { DistributorSubscriptionView } from './DistributorSubscriptionView.tsx';

interface AdminDashboardProps {
  user: User;
  lang: Language;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ user, lang }) => {
  const t = translations[lang];
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'orders' | 'demand' | 'shops' | 'products' | 'delivery' | 'payments' | 'subscription' | 'reports' | 'settings'
  >('dashboard');

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const tomorrowStr = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const yesterdayStr = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [selectedDate, setSelectedDate] = useState(todayStr);

  // Data states
  const [dashboardMetrics, setDashboardMetrics] = useState<any>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [demandData, setDemandData] = useState<any>(null);
  const [shops, setShops] = useState<Shop[]>([]);

  // STRICT MULTI-TENANCY: A distributor must ONLY ever see their own retailers
  const myDistId = user?.distributor_id ? Number(user.distributor_id) : null;
  const filteredDistShops = useMemo(() => {
    if (!myDistId) return shops;
    return shops.filter((s) => s.distributor_id && Number(s.distributor_id) === myDistId);
  }, [shops, myDistId]);

  // STRICT MULTI-TENANCY: Only show unsubmitted shops belonging to THIS distributor
  const unsubmittedShops = useMemo(() => {
    const rawList = dashboardMetrics?.unsubmitted_shops || [];
    if (!myDistId) return rawList;
    const myShopIds = new Set(filteredDistShops.map((s) => s.id));
    return rawList.filter((s: any) => {
      if (s.distributor_id) return Number(s.distributor_id) === myDistId;
      return myShopIds.has(s.id);
    });
  }, [dashboardMetrics?.unsubmitted_shops, myDistId, filteredDistShops]);
  const [products, setProducts] = useState<Product[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [settings, setSettingsState] = useState<SystemSettings | null>(null);
  const [subStatusData, setSubStatusData] = useState<{
    daysRemaining: number;
    isExpired: boolean;
    isExpiringSoon: boolean;
    planName: string;
    renewalDate: string;
  } | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRoute, setSelectedRoute] = useState('All');
  const [selectedStatus, setSelectedStatus] = useState('All');

  // Modals
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [showManualOrderModal, setShowManualOrderModal] = useState(false);
  const [showAddShopModal, setShowAddShopModal] = useState(false);
  const [editingShop, setEditingShop] = useState<Shop | null>(null);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false);
  const [selectedShopLedger, setSelectedShopLedger] = useState<any>(null);
  const [shopToDelete, setShopToDelete] = useState<Shop | null>(null);
  const [isDeletingShop, setIsDeletingShop] = useState(false);
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);
  const [isDeletingProduct, setIsDeletingProduct] = useState(false);
  const [resetPinShop, setResetPinShop] = useState<Shop | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [isUpdatingPin, setIsUpdatingPin] = useState(false);

  // Feedback & Modal editing states
  const [copiedSuccess, setCopiedSuccess] = useState(false);
  const [successToast, setSuccessToast] = useState('');
  const [errorToast, setErrorToast] = useState('');
  const [modalError, setModalError] = useState('');
  const [selectedNewStatus, setSelectedNewStatus] = useState<OrderStatus | null>(null);
  const [auditReasonInput, setAuditReasonInput] = useState('');
  const [shopCodeInput, setShopCodeInput] = useState('');
  const [editableOrderItems, setEditableOrderItems] = useState<any[]>([]);
  const [selectedAddProductId, setSelectedAddProductId] = useState<number | ''>('');
  const [isSavingOrderEdit, setIsSavingOrderEdit] = useState(false);

  const handleOpenEditOrder = (order: Order) => {
    setEditingOrder(order);
    setSelectedNewStatus(order.status);
    setAuditReasonInput('');
    setModalError('');
    setSelectedAddProductId('');
    setEditableOrderItems(
      (order.items || []).map((it) => ({
        ...it,
        original_ordered_quantity: it.ordered_quantity ?? 0,
        ordered_quantity: it.ordered_quantity ?? 0,
        delivered_quantity: it.delivered_quantity ?? (it.ordered_quantity ?? 0),
        unit_price: it.unit_price ?? 0,
        line_total: Math.round((it.unit_price || 0) * (it.ordered_quantity || 0) * 100) / 100,
      }))
    );
  };

  const handleStepOrderItemQty = (idx: number, delta: number) => {
    setEditableOrderItems((prev) => {
      const copy = [...prev];
      const cur = copy[idx].ordered_quantity || 0;
      const next = Math.max(0, cur + delta);
      copy[idx] = {
        ...copy[idx],
        ordered_quantity: next,
        line_total: Math.round((copy[idx].unit_price || 0) * next * 100) / 100,
      };
      return copy;
    });
  };

  const handleDirectOrderItemQty = (idx: number, valStr: string) => {
    const val = parseInt(valStr, 10);
    const q = isNaN(val) ? 0 : Math.max(0, val);
    setEditableOrderItems((prev) => {
      const copy = [...prev];
      copy[idx] = {
        ...copy[idx],
        ordered_quantity: q,
        line_total: Math.round((copy[idx].unit_price || 0) * q * 100) / 100,
      };
      return copy;
    });
  };

  const handleStepOrderDeliveredQty = (idx: number, delta: number) => {
    setEditableOrderItems((prev) => {
      const copy = [...prev];
      const cur = copy[idx].delivered_quantity || 0;
      const next = Math.max(0, cur + delta);
      copy[idx] = {
        ...copy[idx],
        delivered_quantity: next,
      };
      return copy;
    });
  };

  const handleDirectOrderDeliveredQty = (idx: number, valStr: string) => {
    const val = parseInt(valStr, 10);
    const q = isNaN(val) ? 0 : Math.max(0, val);
    setEditableOrderItems((prev) => {
      const copy = [...prev];
      copy[idx] = {
        ...copy[idx],
        delivered_quantity: q,
      };
      return copy;
    });
  };

  const handleRemoveOrderItem = (idx: number) => {
    setEditableOrderItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleAddProductToOrder = () => {
    if (!selectedAddProductId) return;
    const p = products.find((prod) => prod.id === Number(selectedAddProductId));
    if (!p) return;

    const existingIdx = editableOrderItems.findIndex((it) => it.product_id === p.id);
    if (existingIdx >= 0) {
      handleStepOrderItemQty(existingIdx, 1);
    } else {
      setEditableOrderItems((prev) => [
        ...prev,
        {
          product_id: p.id,
          name: p.name_hi || p.name,
          product_name: p.name_hi || p.name,
          name_hi: p.name_hi,
          name_english: p.name_english,
          unit: p.unit,
          unit_price: p.price,
          original_ordered_quantity: 0,
          ordered_quantity: 1,
          delivered_quantity: 1,
          line_total: p.price,
        },
      ]);
    }
    setSelectedAddProductId('');
  };

  const handleOpenAddShop = async () => {
    if (user?.max_shops && filteredDistShops.length >= user.max_shops) {
      setErrorToast(
        lang === 'hi'
          ? `आपके वर्तमान प्लान में अधिकतम ${user.max_shops} सक्रिय दुकानों की सीमा है। नई दुकान जोड़ने के लिए कृपया अपना प्लान अपग्रेड करें।`
          : `Your current plan limit of ${user.max_shops} active shops is reached. Please upgrade your plan to add more shops.`
      );
      return;
    }

    // 1. Initial quick calculate from current shops state
    let nextNum = 101;
    if (shops.length > 0) {
      const nums = shops
        .map((s) => {
          const match = s.shop_code?.match(/\d+/);
          return match ? parseInt(match[0], 10) : 0;
        })
        .filter((n) => !isNaN(n) && n > 0);
      if (nums.length > 0) {
        nextNum = Math.max(...nums) + 1;
      }
    }
    setShopCodeInput(`SH-${nextNum}`);
    setEditingShop(null);
    setModalError('');
    setShowAddShopModal(true);

    // 2. Fetch global network-wide next code across all distributors
    try {
      const res = await api.getNextShopCode();
      if (res && res.next_code) {
        setShopCodeInput(res.next_code);
      }
    } catch (e) {
      // Retain local calculate
    }
  };

  const handleGenerateNextShopCode = async () => {
    try {
      const res = await api.getNextShopCode();
      if (res && res.next_code) {
        setShopCodeInput(res.next_code);
        return;
      }
    } catch (e) {}
    let nextNum = 101;
    if (shops.length > 0) {
      const nums = shops
        .map((s) => {
          const match = s.shop_code?.match(/\d+/);
          return match ? parseInt(match[0], 10) : 0;
        })
        .filter((n) => !isNaN(n) && n > 0);
      if (nums.length > 0) {
        nextNum = Math.max(...nums) + 1;
      }
    }
    setShopCodeInput(`SH-${nextNum}`);
  };

  const handleEditShop = (shop: Shop) => {
    setEditingShop(shop);
    setShopCodeInput(shop.shop_code);
    setModalError('');
    setShowAddShopModal(true);
  };

  const handleDistributorQrUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const maxDim = 600;
          let width = img.width;
          let height = img.height;
          if (width > height) {
            if (width > maxDim) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            }
          } else {
            if (height > maxDim) {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            setSettingsState((prev: any) => ({
              ...prev,
              distributor_qr_image: canvas.toDataURL('image/jpeg', 0.85),
            }));
          } else {
            setSettingsState((prev: any) => ({
              ...prev,
              distributor_qr_image: ev.target?.result as string,
            }));
          }
        };
        img.src = ev.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const loadDashboard = async () => {
    try {
      const data = await api.getDashboardMetrics(selectedDate, user?.distributor_id);
      setDashboardMetrics(data);
    } catch (err: any) {
      console.error(err);
    }
  };

  const loadOrders = async () => {
    try {
      const data = await api.getOrders({
        date: selectedDate,
        route: selectedRoute === 'All' ? undefined : selectedRoute,
        status: selectedStatus === 'All' ? undefined : selectedStatus,
        search: searchQuery || undefined,
        distributor_id: user?.distributor_id,
      });
      setOrders(data);
    } catch (err: any) {
      console.error(err);
    }
  };

  const loadDemand = async () => {
    try {
      const routeParam = selectedRoute !== 'all' ? selectedRoute : undefined;
      const data = await api.getConsolidatedDemand(selectedDate, user?.distributor_id, routeParam);
      setDemandData(data);
    } catch (err: any) {
      console.error(err);
    }
  };

  const loadShops = async () => {
    try {
      const data = await api.getShops(user?.distributor_id ? { distributor_id: user.distributor_id } : undefined);
      setShops(data);
    } catch (err: any) {
      console.error(err);
    }
  };

  const loadProducts = async () => {
    try {
      const data = await api.getProducts(user?.distributor_id ? { distributor_id: user.distributor_id } : undefined);
      setProducts(data);
    } catch (err: any) {
      console.error(err);
    }
  };

  const loadPayments = async () => {
    try {
      const data = await api.getPayments({ distributor_id: user?.distributor_id });
      setPayments(data);
    } catch (err: any) {
      console.error(err);
    }
  };

  const handleApprovePayment = async (payId: number) => {
    try {
      await api.approvePayment(payId);
      await Promise.all([loadPayments(), loadShops()]);
    } catch (err: any) {
      alert(err.message || 'भुगतान स्वीकृत करने में विफल');
    }
  };

  const handleRejectPayment = async (payId: number) => {
    const reason = prompt(
      lang === 'hi' ? 'अस्वीकार करने का कारण दर्ज करें:' : 'Enter reason for rejection:',
      lang === 'hi' ? 'अमान्य UTR या बैंक खाते में भुगतान प्राप्त नहीं हुआ' : 'Invalid UTR or payment not received'
    );
    if (reason === null) return;
    try {
      await api.rejectPayment(payId, reason);
      await Promise.all([loadPayments(), loadShops()]);
    } catch (err: any) {
      alert(err.message || 'भुगतान अस्वीकार करने में विफल');
    }
  };

  const loadSettingsAndLogs = async () => {
    try {
      const [sett, logs] = await Promise.all([api.getSettings(user?.distributor_id), api.getAuditLogs()]);
      setSettingsState(sett);
      setAuditLogs(logs);
    } catch (err: any) {
      console.error(err);
    }
  };

  // Load distributor subscription status for banner alerts (Issue 16)
  useEffect(() => {
    api.getMySubscription(myDistId || user?.distributor_id)
      .then((res: any) => {
        if (res && res.distributor) {
          setSubStatusData({
            daysRemaining: res.days_remaining ?? 30,
            isExpired: Boolean(res.is_expired),
            isExpiringSoon: Boolean(res.is_expiring_soon),
            planName: res.distributor?.plan_name || 'Growth Pro',
            renewalDate: res.distributor?.subscription_renewal_date || '',
          });
        }
      })
      .catch(() => {});
  }, [myDistId, user?.distributor_id]);

  useEffect(() => {
    loadDashboard();
    loadOrders();
    loadDemand();
    loadShops();
    loadProducts();
    loadPayments();
    loadSettingsAndLogs();
  }, [selectedDate, selectedRoute, selectedStatus, searchQuery, lang, user?.distributor_id]);

  // Listen to orders in real-time (using onSnapshot) with debouncing to prevent event storms
  useEffect(() => {
    let debounceTimer: any = null;
    const unsubscribe = subscribeToFirestoreOrders(
      (cloudOrders) => {
        if (cloudOrders && cloudOrders.length > 0) {
          const hasMyDistOrder = !myDistId || cloudOrders.some((o: any) => o && Number(o.distributor_id) === myDistId);
          if (hasMyDistOrder) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              console.log(`[Firestore Real-Time] Relevant cloud orders updated. Refreshing dashboard (debounced)...`);
              loadOrders();
              loadDashboard();
              loadDemand();
            }, 300);
          }
        }
      },
      myDistId || undefined
    );

    return () => {
      clearTimeout(debounceTimer);
      if (unsubscribe) unsubscribe();
    };
  }, [selectedDate, selectedRoute, selectedStatus, myDistId]);

  // Sync retailer data and distributor inventory to Firestore for cloud persistence across devices
// Auto-upload shops removed to prevent duplicate sync issues

// Auto-upload products removed to prevent re-creating deleted products

  // Copy WhatsApp Consolidated Demand Summary
  const handleCopyWhatsAppSummary = () => {
    if (!demandData || !demandData.items) return;
    const itemsText = demandData.items
      .filter((it: any) => it.total_ordered > 0)
      .map(
        (it: any, i: number) =>
          `${i + 1}. *${getProductName(it, lang)}*: ${it.total_ordered} ${getUnitName(it.unit, lang)} (${t.pendingQuantity}: ${it.pending_quantity})`
      )
      .join('\n');

    const message = lang === 'hi'
      ? `📦 *${settings?.distributor_name || 'वेदिरतसेतु थोक वितरक'} - ${t.consolidatedDemand}*
📅 ${t.date}: *${selectedDate}*
🏬 ${t.shopsOrderedCount} *${demandData.summary.total_shops_ordered}*
📦 ${t.orderedQuantity}: *${demandData.summary.overall_ordered_units}*
💰 ${t.estimatedValue}: *₹${demandData.summary.overall_amount}*

*उत्पाद वार विवरण:*
${itemsText || 'कोई ऑर्डर प्राप्त नहीं हुआ'}

_वेदिरतसेतु प्रणाली द्वारा स्वचालित_`
      : `📦 *${settings?.distributor_name || 'Wholesale Distribution'} - ${t.consolidatedDemand}*
📅 ${t.date}: *${selectedDate}*
🏬 ${t.shopsOrderedCount} *${demandData.summary.total_shops_ordered}*
📦 ${t.orderedQuantity}: *${demandData.summary.overall_ordered_units} units*
💰 ${t.estimatedValue}: *₹${demandData.summary.overall_amount}*

*Product Breakdown:*
${itemsText || 'No orders placed'}

_Generated by VedirtSetu B2B Ordering System_`;

    navigator.clipboard.writeText(message);
    setCopiedSuccess(true);
    setTimeout(() => setCopiedSuccess(false), 3000);
  };

  // Open WhatsApp directly with Demand Summary
  const handleOpenWhatsAppDemand = () => {
    if (!demandData || !demandData.items) return;
    const itemsText = demandData.items
      .filter((it: any) => it.total_ordered > 0)
      .map(
        (it: any, i: number) =>
          `${i + 1}. *${getProductName(it, lang)}*: ${it.total_ordered} ${getUnitName(it.unit, lang)} (${t.pendingQuantity}: ${it.pending_quantity})`
      )
      .join('\n');

    const message = lang === 'hi'
      ? `📦 *${settings?.distributor_name || 'वेदिरतसेतु थोक वितरक'} - ${t.consolidatedDemand}*
📅 ${t.date}: *${selectedDate}*
🏬 ${t.shopsOrderedCount} *${demandData.summary.total_shops_ordered}*
📦 ${t.orderedQuantity}: *${demandData.summary.overall_ordered_units}*
💰 ${t.estimatedValue}: *₹${demandData.summary.overall_amount}*

*उत्पाद वार विवरण:*
${itemsText || 'कोई ऑर्डर प्राप्त नहीं हुआ'}

_वेदिरतसेतु प्रणाली द्वारा स्वचालित_`
      : `📦 *${settings?.distributor_name || 'VedirtSetu Wholesale'} - ${t.consolidatedDemand}*
📅 ${t.date}: *${selectedDate}*
🏬 ${t.shopsOrderedCount} *${demandData.summary.total_shops_ordered}*
📦 ${t.orderedQuantity}: *${demandData.summary.overall_ordered_units} units*
💰 ${t.estimatedValue}: *₹${demandData.summary.overall_amount}*

*Product Breakdown:*
${itemsText || 'No orders placed'}

_Generated by VedirtSetu B2B Ordering System_`;

    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  // Export CSV
  const handleExportCSV = (filename: string, headers: string[], rows: any[][]) => {
    const csvContent =
      '\uFEFF' +
      [headers.join(','), ...rows.map((e) => e.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))].join(
        '\n'
      );
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `${filename}_${selectedDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Remind unsubmitted shops
  const handleRemindUnsubmitted = async () => {
    try {
      const res = await api.remindUnsubmittedShops(user?.distributor_id);
      setSuccessToast(
        lang === 'hi'
          ? `${res.sentCount} दुकानों को आज के ऑर्डर की याददिहानी भेजी गई।`
          : `Reminder sent to ${res.sentCount} pending shops.`
      );
      setTimeout(() => setSuccessToast(''), 4000);
    } catch (err: any) {
      setErrorToast(err.message || (lang === 'hi' ? 'याददिहानी भेजने में विफल' : 'Failed to send reminders'));
    }
  };

  const renderStatusBadge = (status: OrderStatus) => {
    const map: Record<OrderStatus, string> = {
      Pending: 'bg-amber-100 text-amber-800 border-amber-300',
      Confirmed: 'bg-blue-100 text-blue-800 border-blue-300',
      Packed: 'bg-indigo-100 text-indigo-800 border-indigo-300',
      'Partially Delivered': 'bg-purple-100 text-purple-800 border-purple-300',
      Delivered: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      Cancelled: 'bg-red-100 text-red-800 border-red-300',
    };
    const bg = map[status] || 'bg-slate-100 text-slate-800 border-slate-300';
    return (
      <span className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-black border ${bg}`}>
        {getStatusName(status, lang)}
      </span>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 space-y-4">
      {/* Toast banners */}
      {successToast && (
        <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs sm:text-sm font-bold flex items-center gap-2 shadow-xs">
          <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
          <span>{successToast}</span>
        </div>
      )}
      {errorToast && (
        <div className="p-3.5 rounded-2xl bg-red-50 border border-red-300 text-red-800 text-xs sm:text-sm font-bold flex items-center gap-2 shadow-xs">
          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
          <span>{errorToast}</span>
        </div>
      )}

      {/* Persistent Subscription Expiry / Warning Banner (Issue 16) */}
      {subStatusData && (subStatusData.isExpired || subStatusData.isExpiringSoon) && (
        <div className={`p-4 rounded-2xl border flex flex-wrap items-center justify-between gap-3 shadow-sm ${
          subStatusData.isExpired
            ? 'bg-rose-50 border-rose-300 text-rose-900'
            : 'bg-amber-50 border-amber-300 text-amber-900'
        }`}>
          <div className="flex items-center gap-3">
            <AlertTriangle className={`w-5 h-5 shrink-0 ${subStatusData.isExpired ? 'text-rose-600' : 'text-amber-600'}`} />
            <div>
              <p className="text-xs sm:text-sm font-extrabold">
                {subStatusData.isExpired
                  ? (lang === 'hi'
                      ? 'अलर्ट: आपका प्लेटफॉर्म सब्सक्रिप्शन समाप्त (Expired) हो चुका है!'
                      : 'Alert: Your platform subscription has expired!')
                  : (lang === 'hi'
                      ? `चेतावनी: आपके ${subStatusData.planName} प्लान में केवल ${subStatusData.daysRemaining} दिन शेष हैं!`
                      : `Warning: Only ${subStatusData.daysRemaining} days remaining in your ${subStatusData.planName} plan!`)}
              </p>
              <p className="text-[11px] opacity-80 mt-0.5">
                {subStatusData.isExpired
                  ? (lang === 'hi'
                      ? 'दुकानों से ऑर्डर व डिलीवरी सेवाएं निर्बाध रखने हेतु कृपया तुरंत रिन्यू करें।'
                      : 'Please renew immediately to prevent order and delivery service interruptions.')
                  : (lang === 'hi'
                      ? `नवीनीकरण देय तिथि: ${subStatusData.renewalDate}। असुविधा से बचने के लिए अभी रिन्यू करें।`
                      : `Renewal due date: ${subStatusData.renewalDate}. Renew now to ensure seamless operation.`)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('subscription')}
            className={`px-4 py-2 rounded-xl text-xs font-black shadow-xs flex items-center gap-1.5 transition active:scale-95 cursor-pointer ${
              subStatusData.isExpired
                ? 'bg-rose-600 hover:bg-rose-700 text-white'
                : 'bg-amber-500 hover:bg-amber-600 text-slate-950'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{lang === 'hi' ? '⚡ अभी रिन्यू करें' : '⚡ Renew Now'}</span>
          </button>
        </div>
      )}

      {/* Admin Top Navigation Tabs */}
      <div className="flex items-center gap-1.5 p-1.5 bg-white rounded-2xl border border-slate-200 overflow-x-auto shadow-xs no-scrollbar">
        {[
          { id: 'dashboard', label: t.dashboard, icon: LayoutDashboard },
          { id: 'orders', label: t.todaysOrders, icon: ClipboardList },
          { id: 'demand', label: t.consolidatedDemand, icon: Layers },
          { id: 'shops', label: t.shops, icon: Store },
          { id: 'products', label: t.products, icon: Package },
          { id: 'delivery', label: t.deliveryStatus, icon: Truck },
          { id: 'payments', label: t.paymentsLedger, icon: CreditCard },
          { id: 'subscription', label: lang === 'hi' ? 'प्लान व सब्सक्रिप्शन' : 'Subscription', icon: Zap },
          { id: 'reports', label: t.reports, icon: BarChart3 },
          { id: 'settings', label: t.settings, icon: Settings },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-black whitespace-nowrap transition ${
                isActive
                  ? 'bg-emerald-800 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Date & Quick Action Bar */}
      <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Calendar className="w-4 h-4 text-emerald-700" />
          <span className="text-xs font-bold text-slate-700">{lang === 'hi' ? 'दिनांक:' : 'Date:'}</span>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-3 py-1.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-800 focus:border-emerald-600 focus:ring-1 focus:ring-emerald-200 outline-hidden"
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSelectedDate(todayStr)}
              className={`text-[11px] font-bold px-2.5 py-1 rounded-lg transition ${
                selectedDate === todayStr
                  ? 'bg-emerald-800 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {t.today}
            </button>
            <button
              type="button"
              onClick={() => setSelectedDate(tomorrowStr)}
              className={`text-[11px] font-bold px-2.5 py-1 rounded-lg transition ${
                selectedDate === tomorrowStr
                  ? 'bg-emerald-800 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {lang === 'hi' ? 'कल (अगला)' : 'Tomorrow'}
            </button>
            <button
              type="button"
              onClick={() => setSelectedDate(yesterdayStr)}
              className={`text-[11px] font-bold px-2.5 py-1 rounded-lg transition ${
                selectedDate === yesterdayStr
                  ? 'bg-emerald-800 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {lang === 'hi' ? 'बीता कल' : 'Yesterday'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setShowManualOrderModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold shadow-xs transition"
          >
            <Plus className="w-4 h-4" />
            <span>{t.manualOrder}</span>
          </button>

          <button
            onClick={() => setShowRecordPaymentModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold transition"
          >
            <CreditCard className="w-4 h-4 text-emerald-700" />
            <span>{t.recordPayment}</span>
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* 1. SECTION: DASHBOARD */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'dashboard' && dashboardMetrics && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-xs text-slate-500 font-bold">{t.totalActiveShops}</div>
              <div className="text-2xl font-black text-slate-900 mt-1">{filteredDistShops.length || dashboardMetrics.total_active_shops}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">{t.networkSize}</div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-xs text-slate-500 font-bold">{t.totalOrdersToday}</div>
              <div className="text-2xl font-black text-emerald-800 mt-1">{dashboardMetrics.total_orders}</div>
              <div className="text-[10px] text-slate-500 font-semibold mt-0.5">
                {t.Pending}: {dashboardMetrics.pending_orders} • {t.Confirmed}: {dashboardMetrics.confirmed_orders}
              </div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-xs text-slate-500 font-bold">{t.totalOrderValue}</div>
              <div className="text-2xl font-black text-emerald-900 mt-1">
                {formatCurrency(dashboardMetrics.total_order_value)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">{t.dailyBilling}</div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-xs text-slate-500 font-bold">{t.unsubmittedShops}</div>
              <div className="text-2xl font-black text-amber-600 mt-1">
                {unsubmittedShops.length}
              </div>
              <div className="text-[10px] text-amber-800 font-semibold mt-0.5">
                {lang === 'hi' ? 'जिन्होंने ऑर्डर नहीं दिया' : 'Pending submissions'}
              </div>
            </div>
          </div>

          {/* Unsubmitted Shops Reminder Card */}
          {unsubmittedShops.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 sm:p-5 shadow-xs space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-amber-900 font-black text-sm sm:text-base">
                  <AlertTriangle className="w-5 h-5 text-amber-600" />
                  <span>
                    {t.unsubmittedShops} ({unsubmittedShops.length})
                  </span>
                </div>
                <button
                  onClick={handleRemindUnsubmitted}
                  className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 active:scale-95 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{t.remindAll}</span>
                </button>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                {unsubmittedShops.map((s: any) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-white border border-amber-200 text-xs font-bold text-slate-800"
                  >
                    <span>{s.shop_code}</span>
                    <span className="text-slate-400">•</span>
                    <span>{getShopName(s.shop_name, lang)}</span>
                    <span className="text-[10px] text-amber-800">({getRouteName(s.route, lang)})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Product Quantities Snapshot */}
          <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-black text-sm sm:text-base text-slate-900">
                {t.demandSnapshot}
              </h3>
              <button
                onClick={() => setActiveTab('demand')}
                className="text-xs text-emerald-700 hover:underline font-bold"
              >
                {t.viewFullDemand}
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {dashboardMetrics.product_quantities?.map((p: any) => (
                <div key={p.id} className="p-3 rounded-2xl bg-slate-50 border border-slate-200">
                  <div className="text-xs font-bold text-slate-800 truncate">
                    {getProductName(p, lang)}
                  </div>
                  <div className="text-lg font-black text-emerald-900 mt-1">
                    {p.total_ordered} <span className="text-xs text-slate-500 font-normal">{getUnitName(p.unit, lang)}</span>
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {t.deliveredQuantity}: {p.total_delivered}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 2. SECTION: TODAY'S ORDERS */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'orders' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 bg-white p-3 rounded-2xl border border-slate-200">
            <div className="relative col-span-2">
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.search}
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-xs font-medium focus:border-emerald-600 outline-hidden"
              />
            </div>

            <select
              value={selectedRoute}
              onChange={(e) => setSelectedRoute(e.target.value)}
              className="py-2 px-3 rounded-xl border border-slate-300 text-xs font-bold text-slate-700 outline-hidden"
            >
              <option value="All">{t.allRoutes}</option>
              {Array.from(
                new Set([
                  'Route 1 - North',
                  'Route 2 - Central',
                  'Route 3 - South',
                  ...filteredDistShops.map((s) => s.route).filter(Boolean),
                ])
              ).map((rt) => (
                <option key={rt} value={rt}>
                  {getRouteName(rt, lang)}
                </option>
              ))}
            </select>

            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="py-2 px-3 rounded-xl border border-slate-300 text-xs font-bold text-slate-700 outline-hidden"
            >
              <option value="All">{t.allStatuses}</option>
              <option value="Pending">{t.Pending}</option>
              <option value="Confirmed">{t.Confirmed}</option>
              <option value="Packed">{t.Packed}</option>
              <option value="Partially Delivered">{t['Partially Delivered']}</option>
              <option value="Delivered">{t.Delivered}</option>
              <option value="Cancelled">{t.Cancelled}</option>
            </select>
          </div>

          {/* Orders Table */}
          <div className="bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100/80 border-b border-slate-200 text-slate-700 font-extrabold">
                  <tr>
                    <th className="p-3.5">{t.orderNumber}</th>
                    <th className="p-3.5">{t.shopName} / {t.ownerName}</th>
                    <th className="p-3.5">{t.route} & {t.area}</th>
                    <th className="p-3.5">{t.productCatalog}</th>
                    <th className="p-3.5">{t.totalAmount}</th>
                    <th className="p-3.5">{lang === 'hi' ? 'कटऑफ' : 'Cutoff'}</th>
                    <th className="p-3.5">{lang === 'hi' ? 'स्थिति' : 'Status'}</th>
                    <th className="p-3.5 text-right">{t.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {orders.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-slate-400">
                        {lang === 'hi' ? 'कोई ऑर्डर नहीं मिला' : 'No orders found'}
                      </td>
                    </tr>
                  ) : (
                    orders.map((ord) => (
                      <tr key={ord.id} className="hover:bg-slate-50 transition">
                        <td className="p-3.5 font-black text-slate-900">{ord.order_number}</td>
                        <td className="p-3.5">
                          <div className="font-bold text-slate-800">{getShopName(ord.shop_name, lang)}</div>
                          <div className="text-[11px] text-slate-500">
                            {ord.shop_code} • {ord.mobile}
                          </div>
                        </td>
                        <td className="p-3.5">
                          <div className="font-bold text-slate-700">{getRouteName(ord.route || '', lang)}</div>
                          <div className="text-[11px] text-slate-500">{getAreaName(ord.area, lang)}</div>
                        </td>
                        <td className="p-3.5 max-w-xs">
                          {ord.items && ord.items.length > 0 ? (
                            <div className="truncate text-slate-600">
                              {ord.items.map((it) => `${getProductName(it, lang)} (${it.ordered_quantity})`).join(', ')}
                            </div>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="p-3.5 font-black text-emerald-900 text-sm">
                          {formatCurrency(ord.total_amount)}
                        </td>
                        <td className="p-3.5">
                          {ord.cutoff_status === 'late' ? (
                            <span className="text-[10px] font-black bg-amber-100 text-amber-900 px-2 py-0.5 rounded-md">
                              {t.late}
                            </span>
                          ) : (
                            <span className="text-[10px] font-black text-emerald-700">
                              {t.on_time}
                            </span>
                          )}
                        </td>
                        <td className="p-3.5">{renderStatusBadge(ord.status)}</td>
                        <td className="p-3.5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                const msg = formatOrderWhatsAppMessage(ord, ord.shop_name, lang);
                                openWhatsAppShare(msg, ord.mobile);
                              }}
                              title={lang === 'hi' ? 'दुकानदार को व्हाट्सएप भेजें' : 'Send WhatsApp to retailer'}
                              className="p-1.5 rounded-lg border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 transition active:scale-95"
                            >
                              <MessageCircle className="w-3.5 h-3.5 fill-emerald-700 text-emerald-700" />
                            </button>
                            <button
                              onClick={() => handleOpenEditOrder(ord)}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 font-bold text-xs text-emerald-850 transition active:scale-95 shadow-2xs"
                              title={lang === 'hi' ? 'दुकानदार का ऑर्डर एडिट या संशोधित करें' : 'Edit retailer order quantities and items'}
                            >
                              <Edit3 className="w-3.5 h-3.5 text-emerald-750" />
                              <span>{lang === 'hi' ? 'एडिट करें (Edit)' : 'Edit Order'}</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 3. SECTION: CONSOLIDATED DEMAND */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'demand' && demandData && (
        <div className="space-y-4">
          <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
                <Layers className="w-5 h-5 text-emerald-700" />
                <span>{t.consolidatedDemand}</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {t.date}: <span className="font-bold text-slate-800">{selectedDate}</span> • {t.shopsOrderedCount}{' '}
                <span className="font-bold text-emerald-800">{demandData.summary.total_shops_ordered}</span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleOpenWhatsAppDemand}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold shadow-xs transition"
              >
                <MessageCircle className="w-4 h-4 fill-white" />
                <span>{lang === 'hi' ? 'व्हाट्सएप पर भेजें' : 'Share WhatsApp'}</span>
              </button>

              <button
                onClick={handleCopyWhatsAppSummary}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 active:scale-95 text-white text-xs font-bold shadow-xs transition"
              >
                {copiedSuccess ? <Check className="w-4 h-4 text-emerald-300" /> : <Copy className="w-4 h-4" />}
                <span>{copiedSuccess ? t.copiedSuccess : t.copySummary}</span>
              </button>

              <button
                onClick={() =>
                  handleExportCSV(
                    lang === 'hi' ? 'दैनिक_थोक_कुल_मांग' : 'Wholesale_Consolidated_Demand',
                    [t.productCatalog, t.category, t.unit, t.rate, t.orderedQuantity, t.deliveredQuantity, t.pendingQuantity, t.totalAmount],
                    demandData.items.map((it: any) => [
                      getProductName(it, lang),
                      getCategoryName(it.category, lang),
                      getUnitName(it.unit, lang),
                      it.price,
                      it.total_ordered,
                      it.total_delivered,
                      it.pending_quantity,
                      it.total_amount,
                    ])
                  )
                }
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold transition"
              >
                <Download className="w-4 h-4 text-slate-500" />
                <span>{t.exportCsv}</span>
              </button>

              <button
                onClick={() => window.print()}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold transition"
              >
                <Printer className="w-4 h-4 text-slate-500" />
                <span>{t.printDemand}</span>
              </button>
            </div>
          </div>

          {/* Master Consolidated Demand Table */}
          <div className="bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-emerald-900 text-white font-extrabold">
                  <tr>
                    <th className="p-3.5">{t.productCatalog}</th>
                    <th className="p-3.5">{t.category}</th>
                    <th className="p-3.5">{t.unit}</th>
                    <th className="p-3.5">{t.rate}</th>
                    <th className="p-3.5 text-center bg-emerald-800">{t.orderedQuantity}</th>
                    <th className="p-3.5 text-center">{t.deliveredQuantity}</th>
                    <th className="p-3.5 text-center bg-amber-700 text-white">{t.pendingQuantity}</th>
                    <th className="p-3.5 text-right">{t.estimatedValue}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {demandData.items.map((it: any) => (
                    <tr
                      key={it.product_id}
                      className={`hover:bg-slate-50 transition ${
                        it.total_ordered > 0 ? 'bg-white' : 'bg-slate-50/50 text-slate-400'
                      }`}
                    >
                      <td className="p-3.5">
                        <div className="font-black text-slate-900 text-sm">{getProductName(it, lang)}</div>
                      </td>
                      <td className="p-3.5 font-bold text-slate-600">{getCategoryName(it.category, lang)}</td>
                      <td className="p-3.5 font-bold text-slate-700">{getUnitName(it.unit, lang)}</td>
                      <td className="p-3.5 font-bold text-slate-700">{formatCurrency(it.price)}</td>
                      <td className="p-3.5 text-center font-black text-sm bg-emerald-50 text-emerald-950">
                        {it.total_ordered}
                      </td>
                      <td className="p-3.5 text-center font-bold text-slate-700">{it.total_delivered}</td>
                      <td className="p-3.5 text-center font-black text-sm bg-amber-50 text-amber-900">
                        {it.pending_quantity}
                      </td>
                      <td className="p-3.5 text-right font-black text-sm text-slate-900">
                        {formatCurrency(it.total_amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-100 font-black text-slate-900 border-t-2 border-slate-300">
                  <tr>
                    <td colSpan={4} className="p-4 text-sm">
                      {t.grandTotal}
                    </td>
                    <td className="p-4 text-center text-sm text-emerald-900">
                      {demandData.summary.overall_ordered_units}
                    </td>
                    <td className="p-4 text-center text-sm">{demandData.summary.overall_delivered_units}</td>
                    <td className="p-4 text-center text-sm text-amber-800">
                      {demandData.summary.overall_pending_units}
                    </td>
                    <td className="p-4 text-right text-base text-emerald-950">
                      {formatCurrency(demandData.summary.overall_amount)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 4. SECTION: SHOPS MANAGEMENT */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'shops' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
                <Store className="w-5 h-5 text-emerald-700" />
                <span>
                  {t.shopManagement} ({filteredDistShops.length}{user?.max_shops ? ` / ${user.max_shops}` : ''} {t.totalShopsCount})
                </span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'hi' ? 'दुकानों का विवरण, आज का ऑर्डर व बकाया खाता' : 'Shop profiles, orders and ledger balances'}
              </p>
            </div>
            <button
              onClick={handleOpenAddShop}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-xs transition"
            >
              <Plus className="w-4 h-4" />
              <span>{t.addNewShop}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {filteredDistShops.map((shop) => (
              <div
                key={shop.id}
                className="bg-white p-4 rounded-3xl border border-slate-200 shadow-xs flex flex-col justify-between space-y-3"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-900 border border-emerald-200">
                      {shop.shop_code}
                    </span>
                    <span
                      className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                        shop.today_order_status === 'Not Ordered'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {t.todayStatus}: {getStatusName(shop.today_order_status || 'Not Ordered', lang)}
                    </span>
                  </div>
                  <h3 className="font-black text-sm sm:text-base text-slate-900 mt-2">{getShopName(shop.shop_name, lang)}</h3>
                  <div className="text-xs text-slate-500 mt-0.5">{t.ownerName}: {shop.owner_name}</div>
                  <div className="text-xs text-slate-500">{t.phone}: {shop.mobile}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    {getAreaName(shop.area, lang)} • <span className="font-bold text-slate-700">{getRouteName(shop.route, lang)}</span>
                  </div>

                  {/* Shopkeeper Security PIN & WhatsApp Share */}
                  <div className="mt-2.5 p-2 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 text-emerald-700" />
                      <span className="text-[11px] text-slate-500 font-bold">{lang === 'hi' ? 'सुरक्षा पिन:' : 'PIN:'}</span>
                      <span className="font-mono font-black text-slate-900 bg-white px-2 py-0.5 rounded-md border border-slate-200 text-xs">
                        {shop.login_pin || '1234'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setResetPinShop(shop);
                          setPinInput(shop.login_pin || '1234');
                        }}
                        className="px-2 py-1 rounded-lg text-slate-600 hover:text-emerald-700 hover:bg-white text-[11px] font-bold border border-transparent hover:border-slate-200 transition flex items-center gap-1"
                        title={lang === 'hi' ? 'पिन बदलें' : 'Reset PIN'}
                      >
                        <KeyRound className="w-3 h-3" />
                        <span>{lang === 'hi' ? 'पिन बदलें' : 'Reset'}</span>
                      </button>

                      <a
                        href={`https://wa.me/91${shop.mobile.replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent(
                          `नमस्ते ${shop.owner_name} जी! वेदिरतसेतु ऐप में आपकी दुकान (${shop.shop_name}) का लॉगिन विवरण:\nआईडी: ${shop.mobile}\nसुरक्षा पिन: ${shop.login_pin || '1234'}\nकृपया ऐप खोलकर लॉगिन करें।`
                        )}`}
                        target="_blank"
                        rel="noreferrer"
                        className="p-1 rounded-lg text-emerald-700 hover:bg-emerald-50 transition"
                        title={lang === 'hi' ? 'व्हाट्सएप पर पिन भेजें' : 'Send ID & PIN via WhatsApp'}
                      >
                        <MessageCircle className="w-4 h-4" />
                      </a>
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">{t.outstandingLedger}</div>
                    <div
                      className={`text-sm font-black ${
                        (shop.outstanding_balance || 0) > 0 ? 'text-amber-600' : 'text-emerald-700'
                      }`}
                    >
                      {formatCurrency(shop.outstanding_balance || 0)}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={async () => {
                        const ledger = await api.getShopLedger(shop.id);
                        setSelectedShopLedger(ledger);
                      }}
                      className="px-2.5 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-100"
                    >
                      {t.ledgerBtn}
                    </button>
                    <button
                      onClick={() => handleEditShop(shop)}
                      className="p-1.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100"
                      title={t.editShop}
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setShopToDelete(shop)}
                      className="p-1.5 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 hover:border-rose-300 transition"
                      title={t.removeShopkeeper || t.deleteShop}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 5. SECTION: PRODUCTS MANAGEMENT */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'products' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
                <Package className="w-5 h-5 text-emerald-700" />
                <span>{t.productsManagement} ({products.length})</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'hi' ? 'दूध, दही, छाछ, लस्सी, पनीर, देसी घी इत्यादि' : 'Milk, curd, buttermilk, lassi, paneer and ghee'}
              </p>
            </div>
            <button
              onClick={() => setShowAddProductModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-xs transition"
            >
              <Plus className="w-4 h-4" />
              <span>{t.addNewProduct}</span>
            </button>
          </div>

          {products.length === 0 ? (
            <div className="bg-white p-12 rounded-3xl border border-dashed border-slate-300 text-center space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center mx-auto">
                <Package className="w-8 h-8" />
              </div>
              <div className="max-w-md mx-auto space-y-1">
                <h3 className="font-black text-base text-slate-800">
                  {lang === 'hi' ? 'कोई उत्पाद उपलब्ध नहीं है' : 'No Products in Catalog'}
                </h3>
                <p className="text-xs text-slate-500">
                  {lang === 'hi'
                    ? 'आपके कैटलॉग में केवल वही उत्पाद दिखाई देंगे जो आप जोड़ेंगे। अपना पहला उत्पाद जोड़ने के लिए नीचे दिए बटन पर क्लिक करें।'
                    : 'Only products added specifically by you will appear in your catalog. Click below to add your first product.'}
                </p>
              </div>
              <button
                onClick={() => {
                  setEditingProduct(null);
                  setShowAddProductModal(true);
                }}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-md transition"
              >
                <Plus className="w-4 h-4" />
                <span>{t.addNewProduct}</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {products.map((p) => (
                <div
                  key={p.id}
                  className="bg-white p-4 rounded-3xl border border-slate-200 shadow-xs flex flex-col justify-between space-y-3"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                        {getCategoryName(p.category, lang)}
                      </span>
                      <span
                        className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                          p.stock_available ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {p.stock_available ? t.inStock : t.outOfStock}
                      </span>
                    </div>
                    <h3 className="font-black text-sm sm:text-base text-slate-900 mt-2">{getProductName(p, lang)}</h3>
                    <div className="text-base font-black text-emerald-900 mt-2">
                      {formatCurrency(p.price)} / {getUnitName(p.unit, lang)}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
                    <span className="text-slate-500 font-bold">{t.minimumQuantity}: {p.minimum_quantity}</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setEditingProduct(p)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-300 text-slate-700 font-bold hover:bg-slate-100 transition"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>{t.editProduct}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setProductToDelete(p)}
                        className="p-1.5 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 border border-transparent hover:border-red-200 transition"
                        title={lang === 'hi' ? 'उत्पाद हटाएं' : 'Delete product'}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 6. SECTION: DELIVERY SHEET */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'delivery' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-black text-emerald-800 uppercase tracking-wider">
                {user?.business_name || settings?.distributor_name || 'VedirtSetu Wholesale'}
              </div>
              <h2 className="text-base font-black text-slate-800 flex items-center gap-2 mt-0.5">
                <Truck className="w-5 h-5 text-emerald-700" />
                <span>{t.deliveryRouteSheet}</span>
              </h2>
              <p className="text-xs text-slate-600 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{t.date}: <strong className="text-slate-900">{selectedDate}</strong></span>
                <span>•</span>
                <span>{t.route}: <strong className="text-slate-900">{selectedRoute !== 'all' ? getRouteName(selectedRoute, lang) : (lang === 'hi' ? 'सभी रूट' : 'All Routes')}</strong></span>
                <span>•</span>
                <span>{lang === 'hi' ? 'कुल दुकानें:' : 'Total Shops:'} <strong className="text-emerald-800">{orders.filter((ord) => ord.status !== 'Cancelled').length}</strong></span>
              </p>
            </div>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-xs transition no-print"
            >
              <Printer className="w-4 h-4" />
              <span>{t.printDeliverySheet}</span>
            </button>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 font-extrabold text-slate-700">
                  <tr>
                    <th className="p-3">{t.shopCode}</th>
                    <th className="p-3">{t.shopName}</th>
                    <th className="p-3">{t.route} / {t.area}</th>
                    <th className="p-3">{t.productCatalog}</th>
                    <th className="p-3">{t.totalAmount}</th>
                    <th className="p-3 text-center">{t.deliverySignature}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {orders.filter((ord) => ord.status !== 'Cancelled').map((ord) => (
                    <tr key={ord.id} className="hover:bg-slate-50">
                      <td className="p-3 font-bold">{ord.shop_code}</td>
                      <td className="p-3">
                        <div className="font-bold">{getShopName(ord.shop_name, lang)}</div>
                        <div className="text-[11px] text-slate-500">{ord.mobile}</div>
                      </td>
                      <td className="p-3">
                        <div className="font-bold">{getRouteName(ord.route || '', lang)}</div>
                        <div className="text-slate-500">{getAreaName(ord.area, lang)}</div>
                      </td>
                      <td className="p-3">
                        {ord.items?.map((it) => (
                          <div key={it.id} className="text-[11px]">
                            • {getProductName(it, lang)}: <strong>{it.ordered_quantity} {getUnitName(it.unit || '', lang)}</strong>
                          </div>
                        ))}
                      </td>
                      <td className="p-3 font-black text-emerald-950">{formatCurrency(ord.total_amount)}</td>
                      <td className="p-3 text-center">
                        <div className="no-print">
                          {renderStatusBadge(ord.status)}
                        </div>
                        <div className="hidden print:block text-center">
                          <div className="border-b border-dashed border-slate-400 h-8 w-28 mx-auto mt-2"></div>
                          <span className="text-[9px] text-slate-500 block mt-0.5">
                            {lang === 'hi' ? 'हस्ताक्षर / प्राप्त राशि' : 'Sign / Cash Recd'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-100/90 font-black text-slate-900 border-t-2 border-slate-300">
                  <tr>
                    <td colSpan={4} className="p-3 text-right">
                      {lang === 'hi' ? 'कुल योग (Total Collection):' : 'Total Route Collection:'}
                    </td>
                    <td className="p-3 text-emerald-950 text-sm">
                      {formatCurrency(
                        orders
                          .filter((ord) => ord.status !== 'Cancelled')
                          .reduce((sum, ord) => sum + (ord.total_amount || 0), 0)
                      )}
                    </td>
                    <td className="p-3 text-center text-[10px] text-slate-500 font-medium">
                      {orders.filter((ord) => ord.status !== 'Cancelled').length} {lang === 'hi' ? 'दुकानें' : 'shops'}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 7. SECTION: PAYMENTS & LEDGER */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'payments' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-emerald-700" />
                <span>{t.paymentsTitle}</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">{t.paymentsSubtext}</p>
            </div>
            <button
              onClick={() => setShowRecordPaymentModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-xs transition"
            >
              <Plus className="w-4 h-4" />
              <span>{t.recordPayment}</span>
            </button>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 font-extrabold text-slate-700">
                  <tr>
                    <th className="p-3.5">{t.receiptNumber}</th>
                    <th className="p-3.5">{t.shopName}</th>
                    <th className="p-3.5">{t.date}</th>
                    <th className="p-3.5">{t.paymentMode}</th>
                    <th className="p-3.5">{t.paymentAmount}</th>
                    <th className="p-3.5">{t.paymentNotes}</th>
                    <th className="p-3.5">{lang === 'hi' ? 'स्थिति' : 'Status'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payments.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="p-3.5 font-bold text-slate-800">#{p.id}</td>
                      <td className="p-3.5">
                        <div className="font-bold text-slate-900">{getShopName(p.shop_name, lang)}</div>
                        <div className="text-[11px] text-slate-500">{p.shop_code}</div>
                      </td>
                      <td className="p-3.5 text-slate-700">{p.payment_date}</td>
                      <td className="p-3.5">
                        <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 font-bold border border-emerald-200">
                          {getPaymentModeName(p.payment_mode, lang)}
                        </span>
                      </td>
                      <td className="p-3.5 font-black text-emerald-900 text-sm">{formatCurrency(p.amount)}</td>
                      <td className="p-3.5 text-slate-600">{p.notes || '-'}</td>
                      <td className="p-3.5">
                        {p.status === 'pending' ? (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 font-bold border border-amber-200">
                              {lang === 'hi' ? 'सत्यापन लंबित' : 'Pending'}
                            </span>
                            <button
                              onClick={() => handleApprovePayment(p.id)}
                              className="px-2 py-0.5 text-[11px] font-bold bg-emerald-600 text-white rounded hover:bg-emerald-700 transition"
                            >
                              {lang === 'hi' ? 'स्वीकार करें' : 'Approve'}
                            </button>
                            <button
                              onClick={() => handleRejectPayment(p.id)}
                              className="px-2 py-0.5 text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100 transition"
                            >
                              {lang === 'hi' ? 'अस्वीकार' : 'Reject'}
                            </button>
                          </div>
                        ) : p.status === 'rejected' ? (
                          <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-800 font-bold border border-rose-200">
                            {lang === 'hi' ? 'अस्वीकृत' : 'Rejected'}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 font-bold border border-emerald-200">
                            {lang === 'hi' ? 'स्वीकृत' : 'Approved'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 7.5 SECTION: DISTRIBUTOR SUBSCRIPTION (SELF-SERVICE RENEWAL) */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'subscription' && (
        <DistributorSubscriptionView lang={lang} user={user} />
      )}

      {/* ------------------------------------------------------------- */}
      {/* 8. SECTION: REPORTS */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'reports' && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
            <h2 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-emerald-700" />
              <span>{t.reportsTitle}</span>
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(() => {
                const activeReportOrders = orders.filter((o) => o.status !== 'Cancelled');
                const activeShopTotal = Math.max(1, filteredDistShops.length || shops.length);
                return (
                  <>
                    <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                      <div className="text-xs text-slate-500 font-bold">{t.fulfillmentRate}</div>
                      <div className="text-2xl font-black text-emerald-800 mt-1">
                        {Math.round((activeReportOrders.length / activeShopTotal) * 100)}%
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1">
                        {activeReportOrders.length} / {filteredDistShops.length || shops.length} {lang === 'hi' ? 'दुकानों ने ऑर्डर दिया' : 'shops ordered'}
                      </div>
                    </div>

                    <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                      <div className="text-xs text-slate-500 font-bold">{t.avgOrderValue}</div>
                      <div className="text-2xl font-black text-slate-800 mt-1">
                        {formatCurrency(
                          activeReportOrders.length > 0
                            ? activeReportOrders.reduce((sum, o) => sum + o.total_amount, 0) / activeReportOrders.length
                            : 0
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1">{t.perShopAvg}</div>
                    </div>

                    <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                      <div className="text-xs text-slate-500 font-bold">{t.ordersAfterCutoff}</div>
                      <div className="text-2xl font-black text-amber-600 mt-1">
                        {activeReportOrders.filter((o) => o.cutoff_status === 'late').length}
                      </div>
                <div className="text-[11px] text-slate-500 mt-1">{t.lateOrders}</div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 9. SECTION: SETTINGS & AUDIT LOGS */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'settings' && settings && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
            <h2 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
              <Settings className="w-5 h-5 text-emerald-700" />
              <span>{t.settingsTitle}</span>
            </h2>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.updateSettings(settings, user?.distributor_id);
                  setSuccessToast(t.settingsSavedSuccess);
                  setTimeout(() => setSuccessToast(''), 3000);
                } catch (err: any) {
                  setErrorToast(err.message || t.error);
                }
              }}
              className="space-y-4 max-w-xl"
            >
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t.dailyCutoffSetting}
                </label>
                <input
                  type="time"
                  value={settings.cutoff_time}
                  onChange={(e) => setSettingsState({ ...settings, cutoff_time: e.target.value })}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm font-bold text-slate-800"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  {t.cutoffSettingSubtext}
                </p>
              </div>

              <label className="flex items-center gap-2 p-3 rounded-2xl border border-slate-200 bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.allow_late_orders}
                  onChange={(e) => setSettingsState({ ...settings, allow_late_orders: e.target.checked })}
                  className="w-4 h-4 rounded text-emerald-700"
                />
                <div>
                  <span className="text-xs font-bold text-slate-800">{t.allowLateOrdersCheckbox}</span>
                  <p className="text-[11px] text-slate-500">
                    {t.allowLateOrdersSubtext}
                  </p>
                </div>
              </label>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">{t.distributorOrgName}</label>
                <input
                  type="text"
                  value={settings.distributor_name}
                  onChange={(e) => setSettingsState({ ...settings, distributor_name: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">{t.distributorMobileSetting}</label>
                <input
                  type="text"
                  value={settings.distributor_mobile}
                  onChange={(e) => setSettingsState({ ...settings, distributor_mobile: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-bold"
                />
              </div>

              {/* Distributor Payment UPI & QR Code Settings */}
              <div className="p-4 rounded-2xl bg-emerald-50/60 border border-emerald-200 space-y-3">
                <div className="flex items-center gap-2">
                  <QrCode className="w-4 h-4 text-emerald-700" />
                  <span className="text-xs font-black text-emerald-950">
                    {lang === 'hi' ? 'दुकानदारों से पेमेंट वसूली हेतु UPI व QR कोड' : 'Payment UPI & QR Code (for Retailers)'}
                  </span>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'वितरक की UPI आईडी (उदा. name@upi):' : 'Distributor UPI ID:'}
                  </label>
                  <input
                    type="text"
                    value={settings.distributor_upi || ''}
                    onChange={(e) => setSettingsState({ ...settings, distributor_upi: e.target.value })}
                    placeholder="उदा. vrindavandairy@okicici"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-xs font-bold bg-white text-slate-900"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">
                    {lang === 'hi'
                      ? 'दुकानदार जब अपने बिल का भुगतान करेंगे तो इसी UPI आईडी पर पैसा आएगा'
                      : 'Retailers will scan or pay directly to this UPI ID for milk dues'}
                  </p>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'वितरक का पेमेंट क्यूआर कोड (QR Image Upload):' : 'Upload Payment QR Image:'}
                  </label>
                  <div className="flex flex-col sm:flex-row items-center gap-3">
                    <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-emerald-300 hover:bg-emerald-50 text-emerald-800 text-xs font-bold transition shadow-xs">
                      <Upload className="w-3.5 h-3.5" />
                      <span>{lang === 'hi' ? 'नया QR इमेज अपलोड करें' : 'Upload New QR'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleDistributorQrUpload}
                        className="hidden"
                      />
                    </label>

                    {settings.distributor_qr_image && (
                      <button
                        type="button"
                        onClick={() => setSettingsState({ ...settings, distributor_qr_image: '' })}
                        className="px-3 py-2 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 text-xs font-bold transition"
                      >
                        {lang === 'hi' ? 'QR इमेज हटाएं' : 'Remove QR'}
                      </button>
                    )}
                  </div>

                  {/* QR Preview Box */}
                  <div className="mt-3 p-3 bg-white rounded-xl border border-slate-200 flex items-center gap-4">
                    <div className="w-24 h-24 bg-slate-50 rounded-lg border border-slate-200 p-1 flex items-center justify-center shrink-0">
                      {settings.distributor_qr_image || settings.distributor_upi ? (
                        <img
                          src={settings.distributor_qr_image || `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=4&data=${encodeURIComponent(`upi://pay?pa=${encodeURIComponent(settings.distributor_upi)}&pn=${encodeURIComponent(settings.distributor_name || 'Wholesale Distributor')}&cu=INR`)}`}
                          alt="QR Code Preview"
                          className="w-full h-full object-contain"
                        />
                      ) : (
                        <QrCode className="w-8 h-8 text-slate-300" />
                      )}
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 block font-bold uppercase">
                        {settings.distributor_qr_image ? (lang === 'hi' ? 'कस्टम अपलोडेड QR कोड' : 'Custom Uploaded QR') : settings.distributor_upi ? (lang === 'hi' ? 'स्वतः उत्पन्न डायनामिक QR' : 'Auto Generated QR') : (lang === 'hi' ? 'QR अभी सेट नहीं है' : 'QR Not Set')}
                      </span>
                      <p className="text-xs font-bold text-slate-800 mt-0.5">
                        {settings.distributor_upi || (lang === 'hi' ? 'कोई UPI आईडी सेट नहीं है' : 'No UPI ID configured')}
                      </p>
                      <p className="text-[10px] text-slate-500 mt-1">
                        {settings.distributor_upi || settings.distributor_qr_image
                          ? (lang === 'hi' ? 'दुकानदार को ऐसा ही QR दिखेगा' : 'Retailers see this QR code')
                          : (lang === 'hi' ? 'दुकानदारों से भुगतान लेने के लिए UPI आईडी भरें' : 'Add UPI ID to receive payments from shops')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                className="px-6 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-xs"
              >
                {t.saveSettings}
              </button>
            </form>
          </div>

          {/* Audit Logs Table */}
          <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs space-y-3">
            <h3 className="font-extrabold text-sm text-slate-900">{t.auditLogsTitle}</h3>
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 text-xs">
              {auditLogs.map((log) => (
                <div key={log.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-slate-900">{log.action}</span>
                    <span className="text-slate-400 ml-2">{log.entity_type} #{log.entity_id}</span>
                    <div className="text-slate-500 mt-0.5">{log.reason || '-'}</div>
                  </div>
                  <div className="text-right">
                    <span className="font-bold text-emerald-800">{log.user_name || 'User'}</span>
                    <div className="text-[10px] text-slate-400">
                      {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: EDIT ORDER & AUDIT NOTE */}
      {/* ------------------------------------------------------------- */}
      {editingOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs">
          <div className="w-full max-w-xl bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto max-h-[85vh] flex flex-col">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div>
                <div className="font-bold text-base">{t.orderNumber} #{editingOrder.order_number}</div>
                <div className="text-xs text-emerald-200">
                  {t.shopName}: {getShopName(editingOrder.shop_name, lang)} ({editingOrder.shop_code})
                </div>
              </div>
              <button
                onClick={() => {
                  setEditingOrder(null);
                  setModalError('');
                  setSelectedNewStatus(null);
                }}
                className="text-white hover:text-emerald-200 text-xl font-bold"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {modalError && (
                <div className="p-3 rounded-xl bg-red-50 text-red-700 text-xs font-bold border border-red-200">
                  {modalError}
                </div>
              )}

              {/* Status Selector */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">{t.selectNewStatus}</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {(['Pending', 'Confirmed', 'Packed', 'Partially Delivered', 'Delivered', 'Cancelled'] as OrderStatus[]).map(
                    (st) => {
                      const isCurrent = (selectedNewStatus || editingOrder.status) === st;
                      return (
                        <button
                          key={st}
                          type="button"
                          onClick={() => {
                            setSelectedNewStatus(st);
                            setAuditReasonInput(
                              lang === 'hi'
                                ? `स्थिति '${getStatusName(st, lang)}' में बदली गई`
                                : `Status changed to ${st}`
                            );
                          }}
                          className={`py-2 px-3 rounded-xl text-xs font-bold border transition ${
                            isCurrent
                              ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs'
                              : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {getStatusName(st, lang)}
                        </button>
                      );
                    }
                  )}
                </div>
              </div>

              {/* Audit Reason Input */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">{t.reasonForChange}</label>
                <input
                  type="text"
                  value={auditReasonInput}
                  onChange={(e) => setAuditReasonInput(e.target.value)}
                  placeholder={lang === 'hi' ? 'उदा. डिलीवरी पूर्ण, आंशिक माल प्राप्त आदि...' : 'e.g. Delivered to shopkeeper, stock adjusted...'}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-medium focus:border-emerald-600 outline-hidden"
                />
              </div>

              {/* Order Items & Quantities Editor (Distributor Control) */}
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                  <div>
                    <label className="block text-xs font-black text-slate-800 uppercase tracking-wider">
                      {lang === 'hi' ? '📦 दुकानदार का ऑर्डर व मात्रा संशोधन (Edit Quantities)' : '📦 Ordered Items & Quantities'}
                    </label>
                    <p className="text-[11px] text-slate-500 font-medium">
                      {lang === 'hi'
                        ? 'दुकानदार द्वारा मंगाए गए सामान की मात्रा सीधे बदलें (उदा. 2 के 4 या 1 करें) या नया सामान जोड़ें।'
                        : 'Directly modify ordered quantities (e.g. change 2 to 4 or 1) or add/remove products.'}
                    </p>
                  </div>
                  <span className="self-start sm:self-auto text-[11px] text-emerald-800 font-bold bg-emerald-50 px-2.5 py-1 rounded-xl border border-emerald-200 shrink-0">
                    {lang === 'hi' ? '✏️ मात्रा स्वतंत्र रूप से बदलें' : '✏️ Free Quantity Editing'}
                  </span>
                </div>

                <div className="border border-slate-200 rounded-2xl overflow-hidden text-xs bg-white shadow-xs">
                  <div className="bg-slate-100/90 px-3.5 py-2.5 font-black text-slate-700 flex justify-between items-center border-b border-slate-200">
                    <span>{t.productCatalog}</span>
                    <span className="text-right">{lang === 'hi' ? 'ऑर्डर मात्रा / डिलीवर' : 'Ordered / Delivered'}</span>
                  </div>

                  <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                    {editableOrderItems.length === 0 ? (
                      <div className="p-4 text-center text-slate-400 font-medium">
                        {lang === 'hi' ? 'कोई उत्पाद नहीं है। नीचे से नया उत्पाद जोड़ें।' : 'No items. Add a product below.'}
                      </div>
                    ) : (
                      editableOrderItems.map((it, idx) => {
                        const unitLabel = getUnitName(it.unit || '', lang);
                        const isQtyModified =
                          it.original_ordered_quantity !== undefined &&
                          it.original_ordered_quantity !== it.ordered_quantity;

                        return (
                          <div key={it.id || it.product_id || idx} className="p-3 sm:p-3.5 space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="font-bold text-slate-900 text-xs sm:text-sm">
                                  {getProductName(it, lang)}
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[11px] text-slate-500 font-medium">
                                    {formatCurrency(it.unit_price)} / {unitLabel}
                                  </span>
                                  {isQtyModified && (
                                    <span className="text-[10px] font-black text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.2 rounded-md">
                                      {lang === 'hi' ? `संशोधित (मूल: ${it.original_ordered_quantity})` : `Edited (Orig: ${it.original_ordered_quantity})`}
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <span className="font-black text-slate-900 text-xs">
                                  {formatCurrency((it.unit_price || 0) * (it.ordered_quantity || 0))}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveOrderItem(idx)}
                                  className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                                  title={lang === 'hi' ? 'उत्पाद हटाएं' : 'Remove item'}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            {/* Stepper Controls Row: Ordered Quantity & Delivered Quantity */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                              {/* 1. Ordered Quantity Stepper */}
                              <div className="p-2 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2">
                                <span className="text-[11px] font-bold text-slate-600">
                                  {lang === 'hi' ? 'ऑर्डर मात्रा:' : 'Ordered Qty:'}
                                </span>
                                <span className="hidden print:inline-block font-black text-xs text-slate-900">
                                  {it.ordered_quantity ?? 0} {unitLabel}
                                </span>
                                <div className="flex items-center gap-1 no-print">
                                  <button
                                    type="button"
                                    onClick={() => handleStepOrderItemQty(idx, -1)}
                                    disabled={(it.ordered_quantity || 0) <= 0}
                                    className="w-7 h-7 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 active:scale-90 text-slate-700 font-black text-xs flex items-center justify-center transition disabled:opacity-30"
                                  >
                                    -
                                  </button>
                                  <input
                                    type="number"
                                    min="0"
                                    value={it.ordered_quantity ?? 0}
                                    onChange={(e) => handleDirectOrderItemQty(idx, e.target.value)}
                                    className="w-14 h-7 text-center font-black text-xs border rounded-lg bg-white text-slate-900 border-slate-300 focus:border-emerald-600 outline-none"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleStepOrderItemQty(idx, 1)}
                                    className="w-7 h-7 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 active:scale-90 text-slate-700 font-black text-xs flex items-center justify-center transition"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>

                              {/* 2. Delivered Quantity Stepper */}
                              <div className="p-2 rounded-xl bg-emerald-50/50 border border-emerald-100 flex items-center justify-between gap-2">
                                <span className="text-[11px] font-bold text-emerald-900">
                                  {lang === 'hi' ? 'डिलीवर मात्रा:' : 'Delivered Qty:'}
                                </span>
                                <span className="hidden print:inline-block font-black text-xs text-emerald-950">
                                  {it.delivered_quantity ?? it.ordered_quantity ?? 0} {unitLabel}
                                </span>
                                <div className="flex items-center gap-1 no-print">
                                  <button
                                    type="button"
                                    onClick={() => handleStepOrderDeliveredQty(idx, -1)}
                                    disabled={(it.delivered_quantity || 0) <= 0}
                                    className="w-7 h-7 rounded-lg bg-white border border-emerald-200 hover:bg-emerald-50 active:scale-90 text-emerald-800 font-black text-xs flex items-center justify-center transition disabled:opacity-30"
                                  >
                                    -
                                  </button>
                                  <input
                                    type="number"
                                    min="0"
                                    value={it.delivered_quantity ?? 0}
                                    onChange={(e) => handleDirectOrderDeliveredQty(idx, e.target.value)}
                                    className="w-14 h-7 text-center font-black text-xs border rounded-lg bg-white text-emerald-950 border-emerald-300 focus:border-emerald-600 outline-none"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleStepOrderDeliveredQty(idx, 1)}
                                    className="w-7 h-7 rounded-lg bg-white border border-emerald-200 hover:bg-emerald-50 active:scale-90 text-emerald-800 font-black text-xs flex items-center justify-center transition"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Add New Product to this Order */}
                <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <select
                    value={selectedAddProductId}
                    onChange={(e) => setSelectedAddProductId(e.target.value ? Number(e.target.value) : '')}
                    className="flex-1 p-2 rounded-xl border border-slate-300 text-xs font-bold bg-white text-slate-800 outline-none"
                  >
                    <option value="">
                      {lang === 'hi' ? '-- इस ऑर्डर में नया उत्पाद जोड़ें --' : '-- Add additional product to order --'}
                    </option>
                    {products
                      .filter((p) => p.active_status === 1)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {getProductName(p, lang)} ({formatCurrency(p.price)} / {getUnitName(p.unit, lang)})
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleAddProductToOrder}
                    disabled={!selectedAddProductId}
                    className="px-3.5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{lang === 'hi' ? 'उत्पाद जोड़ें' : 'Add Product'}</span>
                  </button>
                </div>
              </div>

              {/* Total Amount Live Display */}
              <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 flex justify-between items-center text-xs font-bold">
                <div>
                  <span className="text-emerald-900 font-bold block">{t.totalAmount}:</span>
                  <span className="text-[10px] text-slate-500 font-medium">
                    {editableOrderItems.reduce((acc, it) => acc + (it.ordered_quantity || 0), 0)} {lang === 'hi' ? 'कुल नग/पैकेट' : 'total items'}
                  </span>
                </div>
                <span className="text-lg text-emerald-950 font-black">
                  {formatCurrency(
                    editableOrderItems.reduce(
                      (sum, it) => sum + (it.unit_price || 0) * (it.ordered_quantity || 0),
                      0
                    )
                  )}
                </span>
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 bg-slate-50 flex flex-wrap items-center justify-between gap-2 no-print">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const msg = formatOrderWhatsAppMessage(editingOrder, editingOrder.shop_name, lang);
                    openWhatsAppShare(msg, editingOrder.mobile);
                  }}
                  className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 transition active:scale-95 shadow-xs"
                >
                  <MessageCircle className="w-4 h-4 fill-white" />
                  <span>{lang === 'hi' ? 'व्हाट्सएप भेजें' : 'Send WhatsApp'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-bold flex items-center gap-1.5 transition"
                >
                  <Printer className="w-4 h-4" />
                  <span>{lang === 'hi' ? 'प्रिंट' : 'Print'}</span>
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingOrder(null);
                    setModalError('');
                    setSelectedNewStatus(null);
                  }}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100"
                >
                  {t.close}
                </button>
                <button
                  type="button"
                  disabled={isSavingOrderEdit}
                  onClick={async () => {
                    setModalError('');
                    const effectiveStatus = selectedNewStatus || editingOrder.status;
                    const reason =
                      auditReasonInput.trim() ||
                      (lang === 'hi'
                        ? `वितरक द्वारा मात्रा व स्थिति '${getStatusName(effectiveStatus, lang)}' में अद्यतन`
                        : `Distributor updated items and status to ${effectiveStatus}`);

                    const validItems = editableOrderItems
                      .filter((it) => (it.ordered_quantity || 0) > 0)
                      .map((it) => ({
                        product_id: it.product_id,
                        ordered_quantity: it.ordered_quantity,
                        delivered_quantity: it.delivered_quantity != null ? it.delivered_quantity : it.ordered_quantity,
                        unit_price: it.unit_price,
                      }));

                    if (validItems.length === 0) {
                      setModalError(
                        lang === 'hi'
                          ? 'कृपया कम से कम एक उत्पाद की मात्रा 1 या अधिक रखें।'
                          : 'Please keep at least one product with quantity > 0.'
                      );
                      return;
                    }

                    setIsSavingOrderEdit(true);
                    try {
                      // Atomic single update: items, delivered quantities, total billing, and status in ONE call
                      await api.updateOrder(editingOrder.id, {
                        items: validItems,
                        status: effectiveStatus,
                        reason,
                      });

                      setEditingOrder(null);
                      setSuccessToast(
                        lang === 'hi'
                          ? 'ऑर्डर की मात्रा व स्थिति सफलतापूर्वक सुरक्षित हुई!'
                          : 'Order items and status updated successfully!'
                      );
                      loadOrders();
                      loadDashboard();
                      loadDemand();
                    } catch (err: any) {
                      setModalError(err.message || t.error);
                    } finally {
                      setIsSavingOrderEdit(false);
                    }
                  }}
                  className="px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-black shadow-xs transition flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {isSavingOrderEdit
                      ? (lang === 'hi' ? 'सुरक्षित हो रहा है...' : 'Saving...')
                      : (lang === 'hi' ? 'मात्रा व स्थिति सुरक्षित करें' : 'Save Changes')}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: MANUAL ORDER */}
      {/* ------------------------------------------------------------- */}
      {showManualOrderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base">{t.manualOrder}</div>
              <button
                onClick={() => {
                  setShowManualOrderModal(false);
                  setModalError('');
                }}
                className="text-white hover:text-emerald-200"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              {modalError && (
                <div className="p-3 rounded-xl bg-red-50 text-red-700 text-xs font-bold border border-red-200">
                  {modalError}
                </div>
              )}

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setModalError('');
                  const form = e.currentTarget;
                  const shopId = parseInt(form.shop_id.value, 10);
                  if (!shopId || isNaN(shopId)) {
                    setModalError(lang === 'hi' ? 'कृपया दुकान चुनें।' : 'Please select shop.');
                    return;
                  }
                  const prodQtys: { product_id: number; quantity: number }[] = [];

                  products.forEach((p) => {
                    const el = form[`prod_${p.id}`];
                    const q = el ? parseInt(el.value, 10) : 0;
                    if (q > 0) prodQtys.push({ product_id: p.id, quantity: q });
                  });

                  if (prodQtys.length === 0) {
                    setModalError(
                      lang === 'hi'
                        ? 'कृपया कम से कम एक उत्पाद की मात्रा दर्ज करें'
                        : 'Please enter quantity for at least one product'
                    );
                    return;
                  }

                  try {
                    const newOrd = await api.createOrder({
                      shop_id: shopId,
                      order_date: selectedDate,
                      items: prodQtys,
                      notes:
                        form.notes?.value ||
                        (lang === 'hi'
                          ? 'वितरक द्वारा फोन पर प्राप्त मैन्युअल ऑर्डर'
                          : 'Manual phone order entered by distributor'),
                    });

                    setShowManualOrderModal(false);
                    setModalError('');
                    setSuccessToast(t.orderSavedSuccess);
                    loadOrders();
                    loadDashboard();
                    loadDemand();
                  } catch (err: any) {
                    setModalError(err.message || t.error);
                  }
                }}
                className="space-y-4"
              >
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'दुकान चुनें:' : 'Select Shop:'}
                  </label>
                  <select name="shop_id" required className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-bold">
                    {filteredDistShops.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.shop_code} - {getShopName(s.shop_name, lang)} ({s.owner_name})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 border rounded-2xl p-2">
                  {products.map((p) => (
                    <div key={p.id} className="py-2 flex items-center justify-between text-xs">
                      <div>
                        <div className="font-bold">{getProductName(p, lang)}</div>
                        <div className="text-[11px] text-slate-500">
                          {formatCurrency(p.price)} / {getUnitName(p.unit, lang)}
                        </div>
                      </div>
                      <input
                        type="number"
                        min="0"
                        name={`prod_${p.id}`}
                        defaultValue="0"
                        placeholder="0"
                        className="w-16 p-1.5 rounded-lg border text-center font-bold"
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">{t.notes}:</label>
                  <input
                    type="text"
                    name="notes"
                    placeholder={t.notesPlaceholder}
                    className="w-full p-2 rounded-xl border text-xs"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm"
                >
                  {t.submitDailyOrder}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: ADD / EDIT SHOP */}
      {/* ------------------------------------------------------------- */}
      {(showAddShopModal || editingShop) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base">
                {editingShop ? t.editShop : t.addNewShop}
              </div>
              <button
                onClick={() => {
                  setShowAddShopModal(false);
                  setEditingShop(null);
                }}
                className="text-white hover:text-emerald-200"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-3 text-xs">
              {modalError && (
                <div className="p-3 rounded-xl bg-red-50 text-red-700 text-xs font-bold border border-red-200">
                  {modalError}
                </div>
              )}

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setModalError('');
                  const form = e.currentTarget;
                  const chosenCode = (shopCodeInput || form.shop_code?.value || '').trim().toUpperCase();
                  const shop_name = (form.shop_name.value || '').trim();
                  const owner_name = (form.owner_name.value || '').trim();
                  const mobile = (form.mobile.value || '').trim().replace(/\D/g, '');
                  const address = (form.address.value || '').trim();
                  const area = (form.area.value || '').trim();
                  const route = (form.route.value || '').trim();
                  const pin = (form.pin?.value || '').trim();

                  if (!chosenCode) {
                    setModalError(lang === 'hi' ? 'कृपया दुकान का विशिष्ट कोड (Shop Code) भरें।' : 'Please enter shop code.');
                    return;
                  }
                  if (!shop_name) {
                    setModalError(lang === 'hi' ? 'कृपया दुकान का नाम भरें।' : 'Please enter shop name.');
                    return;
                  }
                  if (!owner_name) {
                    setModalError(lang === 'hi' ? 'कृपया दुकानदार/स्वामी का नाम भरें।' : 'Please enter owner name.');
                    return;
                  }
                  if (!mobile || mobile.length < 10) {
                    setModalError(lang === 'hi' ? 'कृपया वैध 10-अंकीय मोबाइल नंबर दर्ज करें।' : 'Please enter a valid 10-digit mobile number.');
                    return;
                  }
                  if (!address) {
                    setModalError(lang === 'hi' ? 'कृपया दुकान का पूरा पता भरें।' : 'Please enter address.');
                    return;
                  }
                  if (!area) {
                    setModalError(lang === 'hi' ? 'कृपया क्षेत्र / इलाका (Area) भरें।' : 'Please enter area.');
                    return;
                  }
                  if (!route) {
                    setModalError(lang === 'hi' ? 'कृपया डिलीवरी रूट (Route) भरें।' : 'Please enter delivery route.');
                    return;
                  }
                  if (!pin || pin.length < 4) {
                    setModalError(lang === 'hi' ? 'दुकानदार का लॉगिन पिन कम से कम 4 अंकों का होना चाहिए।' : 'PIN must be at least 4 digits.');
                    return;
                  }

                  const data = {
                    shop_code: chosenCode,
                    shop_name,
                    owner_name,
                    mobile,
                    address,
                    area,
                    route,
                    pin,
                    distributor_id: user?.distributor_id || editingShop?.distributor_id,
                    active_status: 1,
                  };

                  try {
                    if (editingShop) {
                      await api.updateShop(editingShop.id, data);
                    } else {
                      await api.createShop(data);
                    }
                    setShowAddShopModal(false);
                    setEditingShop(null);
                    setModalError('');
                    loadShops();
                    setSuccessToast(t.shopSavedSuccess);
                  } catch (err: any) {
                    setModalError(err.message || t.error);
                  }
                }}
                className="space-y-3"
              >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block font-bold text-slate-700">{t.shopCode}: *</label>
                  <span className="text-[10px] text-slate-400 font-bold">
                    {lang === 'hi' ? 'दुकानदार की विशिष्ट आईडी' : 'Unique ID'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    name="shop_code"
                    value={shopCodeInput}
                    onChange={(e) => setShopCodeInput(e.target.value.toUpperCase())}
                    required
                    placeholder="उदा. SH-106"
                    className="flex-1 p-2.5 rounded-xl border border-slate-300 font-mono font-bold uppercase text-slate-900 focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleGenerateNextShopCode}
                    className="px-3 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition whitespace-nowrap border border-slate-200"
                    title="नया कोड जनरेट करें"
                  >
                    🎲 ऑटो-कोड
                  </button>
                </div>
                {/* Collision warning */}
                {shops.some(
                  (s) =>
                    s.shop_code.toUpperCase() === shopCodeInput.trim().toUpperCase() &&
                    s.id !== editingShop?.id
                ) && (
                  <p className="text-[11px] text-rose-600 font-bold mt-1">
                    ⚠️ यह कोड पहले से किसी दुकान को दिया जा चुका है। कृपया दूसरा कोड चुनें या 🎲 ऑटो-कोड दबाएं।
                  </p>
                )}
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">{t.shopName}:</label>
                <input
                  type="text"
                  name="shop_name"
                  defaultValue={editingShop?.shop_name}
                  required
                  className="w-full p-2.5 rounded-xl border border-slate-300 font-bold"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.ownerName}:</label>
                  <input
                    type="text"
                    name="owner_name"
                    defaultValue={editingShop?.owner_name}
                    required
                    className="w-full p-2.5 rounded-xl border border-slate-300"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.phone} (Login ID):</label>
                  <input
                    type="text"
                    name="mobile"
                    defaultValue={editingShop?.mobile}
                    required
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-mono"
                  />
                </div>
              </div>

              {/* Security PIN Field */}
              <div className="p-3 bg-emerald-50/70 rounded-2xl border border-emerald-200">
                <label className="block font-bold text-emerald-950 mb-1 flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5 text-emerald-700" />
                  <span>{lang === 'hi' ? 'दुकानदार सुरक्षा पिन (4-अंकीय):' : 'Shopkeeper Security PIN (4-digit):'} *</span>
                </label>
                <input
                  type="text"
                  name="pin"
                  defaultValue={editingShop?.login_pin || '1234'}
                  maxLength={8}
                  required
                  placeholder="1234"
                  className="w-full p-2 rounded-xl border border-emerald-300 font-mono font-bold tracking-widest text-emerald-950 bg-white"
                />
                <p className="text-[10px] text-emerald-800 mt-1 font-medium">
                  {lang === 'hi'
                    ? 'दुकानदार इस मोबाइल नंबर और पिन के द्वारा ही ऐप में लॉगिन करेगा'
                    : 'The shopkeeper will login using their mobile and this PIN'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.area}:</label>
                  <input
                    type="text"
                    name="area"
                    defaultValue={editingShop?.area}
                    required
                    className="w-full p-2.5 rounded-xl border border-slate-300"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.route}:</label>
                  <select
                    name="route"
                    defaultValue={editingShop?.route || 'Route 1 - North'}
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-bold"
                  >
                    <option value="Route 1 - North">{getRouteName('Route 1 - North', lang)}</option>
                    <option value="Route 2 - Central">{getRouteName('Route 2 - Central', lang)}</option>
                    <option value="Route 3 - South">{getRouteName('Route 3 - South', lang)}</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">{t.address}:</label>
                <textarea
                  name="address"
                  rows={2}
                  defaultValue={editingShop?.address}
                  className="w-full p-2.5 rounded-xl border border-slate-300"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                {editingShop && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = editingShop;
                      setShowAddShopModal(false);
                      setEditingShop(null);
                      setShopToDelete(target);
                    }}
                    className="px-4 py-3 rounded-xl border border-rose-200 text-rose-700 bg-rose-50 hover:bg-rose-100 font-bold text-xs flex items-center justify-center gap-1.5 transition"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>{t.removeShopkeeper || t.deleteShop}</span>
                  </button>
                )}
                <button
                  type="submit"
                  className="flex-1 py-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm shadow-xs transition"
                >
                  {t.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: CONFIRM REMOVE SHOPKEEPER */}
      {/* ------------------------------------------------------------- */}
            {/* ------------------------------------------------------------- */}
      {/* MODAL: CONFIRM DELETE PRODUCT (RELIABLE REACT MODAL - NO WINDOW.CONFIRM) */}
      {/* ------------------------------------------------------------- */}
      {productToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-rose-700 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-300" />
                <span>{lang === 'hi' ? 'उत्पाद हटाने की पुष्टि करें' : 'Confirm Delete Product'}</span>
              </div>
              <button
                onClick={() => setProductToDelete(null)}
                disabled={isDeletingProduct}
                className="text-white hover:text-rose-200"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl space-y-1.5">
                <div className="font-black text-sm text-rose-950 flex items-center justify-between">
                  <span>{getProductName(productToDelete, lang)}</span>
                  <span className="text-xs px-2 py-0.5 rounded-md bg-rose-200 text-rose-900 font-mono">
                    {formatCurrency(productToDelete.price)} / {productToDelete.unit}
                  </span>
                </div>
                <div className="text-slate-600">
                  <span className="font-bold">{lang === 'hi' ? 'श्रेणी:' : 'Category:'}</span> {productToDelete.category}
                </div>
              </div>

              <p className="text-slate-600 font-medium">
                {lang === 'hi'
                  ? 'क्या आप वाकई इस उत्पाद को हटाना चाहते हैं? यदि इस उत्पाद के पुराने ऑर्डर मौजूद हैं, तो पुराना हिसाब-किताब सुरक्षित रहेगा और उत्पाद कैटलॉग से निष्क्रिय (Soft-delete) हो जाएगा।'
                  : 'Are you sure you want to delete this product? Historical order records will be safely preserved.'}
              </p>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setProductToDelete(null)}
                  disabled={isDeletingProduct}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 font-bold hover:bg-slate-100 transition"
                >
                  {t.cancel}
                </button>
                <button
                  type="button"
                  disabled={isDeletingProduct}
                  onClick={async () => {
                    setIsDeletingProduct(true);
                    try {
                      const targetId = productToDelete.id;
                      await api.deleteProduct(targetId);
                      setProducts((prev) => prev.filter((item) => item.id !== targetId));
                      setSuccessToast(lang === 'hi' ? 'उत्पाद सफलतापूर्वक हटा दिया गया' : 'Product deleted successfully');
                      setProductToDelete(null);
                      await loadProducts();
                      await loadDemand();
                    } catch (err: any) {
                      setErrorToast(err.message || (lang === 'hi' ? 'उत्पाद हटाने में विफल' : 'Failed to delete product'));
                    } finally {
                      setIsDeletingProduct(false);
                    }
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold transition flex items-center justify-center gap-1.5 shadow-xs"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>{isDeletingProduct ? (lang === 'hi' ? 'हटाया जा रहा है...' : 'Deleting...') : (lang === 'hi' ? 'हाँ, उत्पाद हटाएं' : 'Yes, Delete Product')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {shopToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-rose-700 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-300" />
                <span>{t.confirmDeleteShopTitle}</span>
              </div>
              <button
                onClick={() => setShopToDelete(null)}
                disabled={isDeletingShop}
                className="text-white hover:text-rose-200"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl space-y-1.5">
                <div className="font-black text-sm text-rose-950 flex items-center justify-between">
                  <span>{getShopName(shopToDelete.shop_name, lang)}</span>
                  <span className="text-xs px-2 py-0.5 rounded-md bg-rose-200 text-rose-900 font-mono">
                    {shopToDelete.shop_code}
                  </span>
                </div>
                <div className="text-slate-600">
                  <span className="font-bold">{t.ownerName}:</span> {shopToDelete.owner_name} •{' '}
                  <span className="font-bold">{t.phone}:</span> {shopToDelete.mobile}
                </div>
                <div className="text-slate-600">
                  <span className="font-bold">{t.area}:</span> {getAreaName(shopToDelete.area, lang)} •{' '}
                  <span className="font-bold">{t.route}:</span> {getRouteName(shopToDelete.route, lang)}
                </div>
                {(shopToDelete.outstanding_balance || 0) > 0 && (
                  <div className="text-amber-800 font-bold mt-1 pt-1 border-t border-rose-200/60">
                    {t.outstandingLedger}: {formatCurrency(shopToDelete.outstanding_balance || 0)}
                  </div>
                )}
              </div>

              <p className="text-slate-600 leading-relaxed">
                {t.confirmDeleteShopDesc}
              </p>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  disabled={isDeletingShop}
                  onClick={() => setShopToDelete(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 font-bold text-slate-700 hover:bg-slate-100 transition"
                >
                  {t.cancel}
                </button>
                <button
                  type="button"
                  disabled={isDeletingShop}
                  onClick={async () => {
                    try {
                      setIsDeletingShop(true);
                      const targetId = shopToDelete.id;
                      const targetCode = shopToDelete.shop_code;
                      const targetMobile = shopToDelete.mobile;
                      await api.deleteShop(targetId, targetCode, targetMobile);
                      setShops((prev) => prev.filter((s) => s.id !== targetId && s.shop_code !== targetCode));
                      setSuccessToast(t.shopDeletedSuccess);
                      setShopToDelete(null);
                      await loadShops();
                      await loadDashboard();
                    } catch (err: any) {
                      setErrorToast(err.message || t.error);
                    } finally {
                      setIsDeletingShop(false);
                    }
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold transition flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>
                    {isDeletingShop
                      ? lang === 'hi'
                        ? 'हटाया जा रहा है...'
                        : 'Removing...'
                      : t.confirmDeleteShopBtn}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: RESET SHOPKEEPER PIN */}
      {/* ------------------------------------------------------------- */}
      {resetPinShop && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-sm flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-300" />
                <span>{lang === 'hi' ? 'दुकानदार का सुरक्षा पिन रीसेट करें' : 'Reset Shopkeeper PIN'}</span>
              </div>
              <button
                onClick={() => setResetPinShop(null)}
                className="text-white hover:text-emerald-200"
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setIsUpdatingPin(true);
                try {
                  await api.resetShopPin(resetPinShop.id, pinInput);
                  setSuccessToast(lang === 'hi' ? 'दुकानदार का पिन सफलतापूर्वक बदल दिया गया!' : 'Shopkeeper PIN updated successfully!');
                  setResetPinShop(null);
                  await loadShops();
                } catch (err: any) {
                  setErrorToast(err.message || (lang === 'hi' ? 'पिन बदलने में त्रुटि' : 'Error updating PIN'));
                } finally {
                  setIsUpdatingPin(false);
                }
              }}
              className="p-5 space-y-4 text-xs"
            >
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl">
                <div className="font-black text-sm text-slate-900">{resetPinShop.shop_name}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {resetPinShop.owner_name} • <span className="font-mono">{resetPinShop.mobile}</span>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  {lang === 'hi' ? 'नया 4 या 6-अंकीय सुरक्षा पिन:' : 'New 4 or 6-digit Security PIN:'} *
                </label>
                <input
                  type="text"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  maxLength={8}
                  required
                  placeholder="1234"
                  className="w-full p-3 rounded-2xl border border-slate-300 font-mono font-black text-center text-xl tracking-widest text-emerald-950 focus:border-emerald-600 outline-hidden bg-slate-50"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  {lang === 'hi' ? 'दुकानदार इस नए पिन से ऐप में लॉगिन करेगा।' : 'The shopkeeper will login with this new PIN.'}
                </p>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setResetPinShop(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 font-bold text-slate-700 hover:bg-slate-100 transition"
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  disabled={isUpdatingPin || pinInput.trim().length < 4}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold transition shadow-xs disabled:opacity-50"
                >
                  {isUpdatingPin ? (lang === 'hi' ? 'सेव हो रहा है...' : 'Saving...') : (lang === 'hi' ? 'पिन सेव करें' : 'Save PIN')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: ADD / EDIT PRODUCT */}
      {/* ------------------------------------------------------------- */}
      {(showAddProductModal || editingProduct) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base">
                {editingProduct ? t.editProduct : t.addNewProduct}
              </div>
              <button
                onClick={() => {
                  setShowAddProductModal(false);
                  setEditingProduct(null);
                }}
                className="text-white hover:text-emerald-200"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-3 text-xs">
              {modalError && (
                <div className="p-3 rounded-xl bg-red-50 text-red-700 text-xs font-bold border border-red-200">
                  {modalError}
                </div>
              )}

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setModalError('');
                  const form = e.currentTarget;
                  const name_hindi = (form.name_hindi.value || '').trim();
                  const name_english = (form.name_english.value || '').trim();
                  const category = (form.category.value || '').trim();
                  const unit = (form.unit.value || '').trim();
                  const price = parseFloat(form.price.value);
                  const minimum_quantity = parseInt(form.minimum_quantity.value, 10);

                  if (!name_hindi) {
                    setModalError(lang === 'hi' ? 'कृपया उत्पाद का हिंदी नाम भरें।' : 'Please enter Hindi name.');
                    return;
                  }
                  if (!name_english) {
                    setModalError(lang === 'hi' ? 'कृपया उत्पाद का अंग्रेजी नाम भरें।' : 'Please enter English name.');
                    return;
                  }
                  if (!category) {
                    setModalError(lang === 'hi' ? 'कृपया उत्पाद की श्रेणी (Category) चुनें।' : 'Please select category.');
                    return;
                  }
                  if (!unit) {
                    setModalError(lang === 'hi' ? 'कृपया इकाई (Unit - जैसे pkt, ltr, kg) भरें।' : 'Please enter unit.');
                    return;
                  }
                  if (isNaN(price) || price <= 0) {
                    setModalError(lang === 'hi' ? 'कृपया वैध मूल्य (Price) दर्ज करें।' : 'Please enter valid price.');
                    return;
                  }
                  if (isNaN(minimum_quantity) || minimum_quantity <= 0) {
                    setModalError(lang === 'hi' ? 'कृपया न्यूनतम ऑर्डर मात्रा (MOQ) 1 या उससे अधिक दर्ज करें।' : 'Please enter MOQ 1 or greater.');
                    return;
                  }

                  const data = {
                    name_english,
                    name_hindi,
                    category,
                    unit,
                    price,
                    minimum_quantity,
                    stock_available: form.stock_available.checked ? 1 : 0,
                    distributor_id: user?.distributor_id || editingProduct?.distributor_id,
                    active_status: 1,
                  };

                  try {
                    if (editingProduct) {
                      await api.updateProduct(editingProduct.id, data);
                    } else {
                      await api.createProduct(data);
                    }
                    setShowAddProductModal(false);
                    setEditingProduct(null);
                    setModalError('');
                    loadProducts();
                    setSuccessToast(t.productSavedSuccess);
                  } catch (err: any) {
                    setModalError(err.message || t.error);
                  }
                }}
                className="space-y-3"
              >
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.productNameHindi}:</label>
                  <input
                    type="text"
                    name="name_hindi"
                    defaultValue={editingProduct?.name_hindi}
                    placeholder="उदा. दूध 1 लीटर"
                    required
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.productNameEnglish}:</label>
                  <input
                    type="text"
                    name="name_english"
                    defaultValue={editingProduct?.name_english}
                    placeholder="e.g. Milk 1 Litre"
                    required
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.category}:</label>
                  <select
                    name="category"
                    defaultValue={editingProduct?.category || 'FMCG'}
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-bold bg-white text-slate-900"
                  >
                    {editingProduct?.category &&
                      !['FMCG', 'Grocery', 'Bakery', 'Beverages', 'Dairy', 'FruitsVeg', 'Hardware', 'Pharma', 'Stationery', 'Sweets', 'Packaging', 'General'].includes(
                        editingProduct.category
                      ) && (
                        <option value={editingProduct.category}>
                          {getCategoryName(editingProduct.category, lang)}
                        </option>
                      )}
                    <option value="FMCG">{getCategoryName('FMCG', lang)}</option>
                    <option value="Grocery">{getCategoryName('Grocery', lang)}</option>
                    <option value="Bakery">{getCategoryName('Bakery', lang)}</option>
                    <option value="Beverages">{getCategoryName('Beverages', lang)}</option>
                    <option value="Dairy">{getCategoryName('Dairy', lang)}</option>
                    <option value="FruitsVeg">{getCategoryName('FruitsVeg', lang)}</option>
                    <option value="Hardware">{getCategoryName('Hardware', lang)}</option>
                    <option value="Pharma">{getCategoryName('Pharma', lang)}</option>
                    <option value="Stationery">{getCategoryName('Stationery', lang)}</option>
                    <option value="Sweets">{getCategoryName('Sweets', lang)}</option>
                    <option value="Packaging">{getCategoryName('Packaging', lang)}</option>
                    <option value="General">{getCategoryName('General', lang)}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.unit}:</label>
                  <select
                    name="unit"
                    defaultValue={editingProduct?.unit || 'packet'}
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-bold bg-white text-slate-900"
                  >
                    {editingProduct?.unit &&
                      !['packet', 'box', 'carton', 'bottle', 'can', 'bag', 'piece', 'strip', 'bundle', 'roll', 'dozen', 'kg', 'gm', 'litre', 'crate', 'jar'].includes(
                        editingProduct.unit
                      ) && (
                        <option value={editingProduct.unit}>
                          {getUnitName(editingProduct.unit, lang)}
                        </option>
                      )}
                    <option value="packet">{getUnitName('packet', lang)}</option>
                    <option value="box">{getUnitName('box', lang)}</option>
                    <option value="carton">{getUnitName('carton', lang)}</option>
                    <option value="bottle">{getUnitName('bottle', lang)}</option>
                    <option value="can">{getUnitName('can', lang)}</option>
                    <option value="bag">{getUnitName('bag', lang)}</option>
                    <option value="piece">{getUnitName('piece', lang)}</option>
                    <option value="strip">{getUnitName('strip', lang)}</option>
                    <option value="bundle">{getUnitName('bundle', lang)}</option>
                    <option value="roll">{getUnitName('roll', lang)}</option>
                    <option value="dozen">{getUnitName('dozen', lang)}</option>
                    <option value="kg">{getUnitName('kg', lang)}</option>
                    <option value="gm">{getUnitName('gm', lang)}</option>
                    <option value="litre">{getUnitName('litre', lang)}</option>
                    <option value="crate">{getUnitName('crate', lang)}</option>
                    <option value="jar">{getUnitName('jar', lang)}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.priceRate}:</label>
                  <input
                    type="number"
                    step="0.1"
                    name="price"
                    defaultValue={editingProduct?.price}
                    required
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-bold text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">{t.minimumQuantity}:</label>
                <input
                  type="number"
                  name="minimum_quantity"
                  defaultValue={editingProduct?.minimum_quantity || 1}
                  min="1"
                  className="w-full p-2.5 rounded-xl border border-slate-300 font-bold text-slate-900"
                />
              </div>

              <label className="flex items-center gap-2 p-3 rounded-2xl border border-slate-200 bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  name="stock_available"
                  defaultChecked={editingProduct ? Boolean(editingProduct.stock_available) : true}
                  className="w-4 h-4 rounded text-emerald-700"
                />
                <span className="font-bold text-slate-800">{t.stockAvailable}</span>
              </label>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="submit"
                  className="flex-1 py-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm shadow-xs transition"
                >
                  {t.save}
                </button>
                {editingProduct && (
                  <button
                    type="button"
                    onClick={() => {
                      const prod = editingProduct;
                      setShowAddProductModal(false);
                      setEditingProduct(null);
                      setProductToDelete(prod);
                    }}
                    className="px-4 py-3 rounded-xl bg-red-50 hover:bg-red-100 text-red-700 font-bold text-sm border border-red-200 transition"
                  >
                    {t.deleteProduct || 'हटाएं'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
    )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: RECORD PAYMENT */}
      {/* ------------------------------------------------------------- */}
      {showRecordPaymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base">{t.recordPayment}</div>
              <button
                onClick={() => {
                  setShowRecordPaymentModal(false);
                  setModalError('');
                }}
                className="text-white hover:text-emerald-200"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-3 text-xs">
              {modalError && (
                <div className="p-3 rounded-xl bg-red-50 text-red-700 font-bold border border-red-200">
                  {modalError}
                </div>
              )}

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setModalError('');
                  const form = e.currentTarget;
                  const shop_id = parseInt(form.shop_id.value, 10);
                  const amount = parseFloat(form.amount.value);
                  const payment_date = (form.payment_date.value || '').trim();
                  const payment_mode = (form.payment_mode.value || '').trim();
                  const notes = (form.notes.value || '').trim();

                  if (!shop_id || isNaN(shop_id)) {
                    setModalError(lang === 'hi' ? 'कृपया दुकान चुनें।' : 'Please select shop.');
                    return;
                  }
                  if (isNaN(amount) || amount <= 0) {
                    setModalError(lang === 'hi' ? 'कृपया वैध भुगतान राशि दर्ज करें।' : 'Please enter valid amount.');
                    return;
                  }
                  if (!payment_date) {
                    setModalError(lang === 'hi' ? 'कृपया भुगतान की तारीख चुनें।' : 'Please select payment date.');
                    return;
                  }
                  if (!payment_mode) {
                    setModalError(lang === 'hi' ? 'कृपया भुगतान माध्यम (Mode) चुनें।' : 'Please select payment mode.');
                    return;
                  }

                  try {
                    await api.recordPayment({
                      shop_id,
                      amount,
                      payment_date,
                      payment_mode,
                      notes,
                    });
                    setShowRecordPaymentModal(false);
                    setModalError('');
                    loadPayments();
                    loadShops();
                    setSuccessToast(t.paymentSavedSuccess);
                  } catch (err: any) {
                    setModalError(err.message || t.error);
                  }
                }}
                className="space-y-3"
              >
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.shopName}:</label>
                  <select name="shop_id" required className="w-full p-2.5 rounded-xl border border-slate-300 font-bold">
                    {filteredDistShops.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.shop_code} - {getShopName(s.shop_name, lang)}
                      </option>
                    ))}
                  </select>
                </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.paymentAmount} (₹):</label>
                  <input
                    type="number"
                    step="1"
                    name="amount"
                    required
                    placeholder="5000"
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-black text-sm"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.date}:</label>
                  <input
                    type="date"
                    name="payment_date"
                    defaultValue={todayStr}
                    required
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">{t.paymentMode}:</label>
                <select name="payment_mode" className="w-full p-2.5 rounded-xl border border-slate-300 font-bold">
                  <option value="UPI">{getPaymentModeName('UPI', lang)}</option>
                  <option value="Cash">{getPaymentModeName('Cash', lang)}</option>
                  <option value="Cheque">{getPaymentModeName('Cheque', lang)}</option>
                  <option value="Bank Transfer">{getPaymentModeName('Bank Transfer', lang)}</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">{t.paymentNotes}:</label>
                <input
                  type="text"
                  name="notes"
                  placeholder="UPI Txn ID..."
                  className="w-full p-2.5 rounded-xl border border-slate-300"
                />
              </div>

              <button
                type="submit"
                className="w-full py-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm"
              >
                {t.save}
              </button>
            </form>
          </div>
        </div>
      </div>
    )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: SHOP LEDGER */}
      {/* ------------------------------------------------------------- */}
      {selectedShopLedger && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs">
          <div className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto max-h-[85vh] flex flex-col">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div>
                <div className="font-bold text-base">{getShopName(selectedShopLedger.shop.shop_name, lang)} - {t.outstandingLedger}</div>
                <div className="text-xs text-emerald-200">
                  {selectedShopLedger.shop.shop_code} • {selectedShopLedger.shop.owner_name}
                </div>
              </div>
              <button onClick={() => setSelectedShopLedger(null)} className="text-white hover:text-emerald-200">
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="p-3 bg-slate-50 border rounded-2xl">
                  <div className="text-slate-500 font-bold">{t.totalBilled}</div>
                  <div className="text-base font-black text-slate-900 mt-0.5">
                    {formatCurrency(selectedShopLedger.summary.total_billed)}
                  </div>
                </div>
                <div className="p-3 bg-slate-50 border rounded-2xl">
                  <div className="text-slate-500 font-bold">{t.totalPaid}</div>
                  <div className="text-base font-black text-emerald-700 mt-0.5">
                    {formatCurrency(selectedShopLedger.summary.total_paid)}
                  </div>
                </div>
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-2xl">
                  <div className="text-amber-800 font-bold">{t.balanceDue}</div>
                  <div className="text-base font-black text-amber-900 mt-0.5">
                    {formatCurrency(selectedShopLedger.summary.balance)}
                  </div>
                </div>
              </div>

              {/* Pending Unconfirmed Orders Callout (Not Billed) */}
              {(selectedShopLedger.summary.pending_orders_amount || 0) > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-2xl flex items-center justify-between text-xs text-amber-950 font-bold">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-amber-700 shrink-0" />
                    <span>
                      {lang === 'hi'
                        ? 'सत्यापन लंबित ऑर्डर (लेज़र में अभी नहीं जुड़ा):'
                        : 'Pending / Unconfirmed Orders (Not billed to ledger):'}
                    </span>
                  </div>
                  <span className="font-black text-amber-900">
                    {formatCurrency(selectedShopLedger.summary.pending_orders_amount || 0)}
                  </span>
                </div>
              )}

              {/* Transactions List */}
              <div className="border border-slate-200 rounded-2xl overflow-hidden divide-y divide-slate-100 text-xs">
                <div className="bg-slate-100 p-2.5 font-bold text-slate-700 flex justify-between">
                  <span>{t.transactionsHistory}</span>
                  <span>{t.paymentAmount}</span>
                </div>
                {[
                  ...(selectedShopLedger.orders || []).map((o: any) => ({
                    txType: 'order' as const,
                    key: `ord-${o.id}`,
                    date: o.order_date,
                    createdAt: o.created_at || o.order_date,
                    raw: o,
                  })),
                  ...(selectedShopLedger.pending_orders || []).map((po: any) => ({
                    txType: 'pending_order' as const,
                    key: `pending-ord-${po.id}`,
                    date: po.order_date,
                    createdAt: po.created_at || po.order_date,
                    raw: po,
                  })),
                  ...(selectedShopLedger.payments || []).map((p: any) => ({
                    txType: 'payment' as const,
                    key: `pay-${p.id}`,
                    date: p.payment_date,
                    createdAt: p.created_at || p.payment_date,
                    raw: p,
                  })),
                ]
                  .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
                  .map((item) => {
                    if (item.txType === 'order') {
                      const o = item.raw;
                      return (
                        <div key={item.key} className="p-2.5 flex justify-between items-center">
                          <div>
                            <span className="font-bold text-slate-800">{t.orderNumber} #{o.order_number}</span>
                            <span className="text-slate-400 ml-2">{o.order_date}</span>
                            <span className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-bold ml-2">
                              {getStatusName(o.status, lang)}
                            </span>
                          </div>
                          <span className="font-black text-slate-900">+{formatCurrency(o.total_amount)}</span>
                        </div>
                      );
                    }
                    if (item.txType === 'pending_order') {
                      const po = item.raw;
                      return (
                        <div key={item.key} className="p-2.5 flex justify-between items-center bg-amber-50/50">
                          <div>
                            <span className="font-bold text-amber-950">{t.orderNumber} #{po.order_number}</span>
                            <span className="text-slate-400 ml-2">{po.order_date}</span>
                            <span className="text-[11px] text-amber-800 bg-amber-100 border border-amber-300 px-1.5 py-0.5 rounded font-bold ml-2">
                              {lang === 'hi' ? 'सत्यापन लंबित (खाते में नहीं जुड़ा)' : 'Pending (Unbilled)'}
                            </span>
                          </div>
                          <span className="font-bold text-amber-800">({formatCurrency(po.total_amount)})</span>
                        </div>
                      );
                    }
                    const p = item.raw;
                    return (
                      <div key={item.key} className="p-2.5 flex justify-between items-center bg-emerald-50/40">
                        <div>
                          <span className="font-bold text-emerald-800">
                            {p.status === 'pending'
                              ? (lang === 'hi' ? 'भुगतान (सत्यापन लंबित)' : 'Payment (Pending Verification)')
                              : p.status === 'rejected'
                              ? (lang === 'hi' ? 'भुगतान (अस्वीकृत)' : 'Payment (Rejected)')
                              : (lang === 'hi' ? 'भुगतान प्राप्त' : 'Payment received')} ({getPaymentModeName(p.payment_mode, lang)})
                          </span>
                          <span className="text-slate-400 ml-2">{p.payment_date}</span>
                        </div>
                        <span className={`font-black ${p.status === 'pending' ? 'text-amber-700' : p.status === 'rejected' ? 'text-slate-400 line-through' : 'text-emerald-700'}`}>
                          -{formatCurrency(p.amount)}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
