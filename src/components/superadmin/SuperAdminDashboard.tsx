import { subscribeToFirestoreDistributors, subscribeToFirestoreShops } from '../../services/firebase.ts';
import React, { useState, useEffect } from 'react';
import {
  User,
  Distributor,
  SubscriptionPayment,
  SuperAdminMetrics,
  SubscriptionStatus,
  DistributorMonitoringData,
  DistributorShopItem,
} from '../../types/index.ts';
import {
  Language,
  translations,
  formatCurrency,
  getSubscriptionStatusName,
} from '../../utils/i18n.ts';
import { api } from '../../services/api.ts';
import {
  Building2,
  Users,
  CreditCard,
  TrendingUp,
  AlertTriangle,
  Plus,
  Search,
  ExternalLink,
  Edit3,
  Trash2,
  CheckCircle2,
  Calendar,
  Phone,
  Mail,
  MapPin,
  Shield,
  Layers,
  Sparkles,
  ArrowRight,
  Clock,
  Receipt,
  PauseCircle,
  PlayCircle,
  PackageCheck,
  Store,
  Activity,
  LayoutGrid,
  List,
  Eye,
  Power,
  ArrowUpRight,
  ChevronRight,
  Filter,
  Check,
  X,
  KeyRound,
  MessageCircle,
  Package,
  Upload,
  QrCode,
  Save,
} from 'lucide-react';
import { SuperAdminNetworkOrdersView } from './SuperAdminNetworkOrdersView.tsx';

interface SuperAdminDashboardProps {
  user: User;
  lang: Language;
  onInspectDistributor: (distributorUser: User, token?: string) => void;
}

export const SuperAdminDashboard: React.FC<SuperAdminDashboardProps> = ({
  user,
  lang,
  onInspectDistributor,
}) => {
  const t = translations[lang];

  // States
  const [metrics, setMetrics] = useState<SuperAdminMetrics | null>(null);
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const sessionDeletedDists = React.useRef<Set<string>>(new Set());
  const [payments, setPayments] = useState<SubscriptionPayment[]>([]);
  const [loading, setLoading] = useState(true);

  // Tabs & View Mode
  const [activeTab, setActiveTab] = useState<'distributors' | 'network_orders' | 'monitor' | 'billing' | 'plans' | 'settings'>('distributors');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [planFilter, setPlanFilter] = useState<string>('all');

  // Platform UPI & QR Management State
  const [platformUpi, setPlatformUpi] = useState('');
  const [platformOwner, setPlatformOwner] = useState('VedirtSetu Platforms');
  const [platformQrImage, setPlatformQrImage] = useState('');
  const [savingPlatformQr, setSavingPlatformQr] = useState(false);
  const [platformQrSavedMsg, setPlatformQrSavedMsg] = useState('');

  // Live Distributor Monitoring View State
  const [selectedMonitorDistributorId, setSelectedMonitorDistributorId] = useState<number | null>(null);
  const [monitoringData, setMonitoringData] = useState<DistributorMonitoringData | null>(null);
  const [loadingMonitoring, setLoadingMonitoring] = useState(false);
  const [monitoringShopSearch, setMonitoringShopSearch] = useState('');
  const [monitoringRouteFilter, setMonitoringRouteFilter] = useState<string>('all');
  const [statusTogglingId, setStatusTogglingId] = useState<number | null>(null);

  // Modals
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingDistributor, setEditingDistributor] = useState<Distributor | null>(null);
  const [paymentDistributor, setPaymentDistributor] = useState<Distributor | null>(null);
  const [distributorToDelete, setDistributorToDelete] = useState<Distributor | null>(null);
  // Dedicated View Distributor Shops Modal
  const [shopViewDistributor, setShopViewDistributor] = useState<Distributor | null>(null);
  const [shopViewLoading, setShopViewLoading] = useState(false);
  const [shopViewList, setShopViewList] = useState<DistributorShopItem[]>([]);
  const [shopViewSearch, setShopViewSearch] = useState('');
  const [shopViewRoute, setShopViewRoute] = useState('all');

  const handleViewDistributorShops = async (dist: Distributor) => {
    setShopViewDistributor(dist);
    setShopViewLoading(true);
    setShopViewSearch('');
    setShopViewRoute('all');
    try {
      const data = await api.getDistributorMonitoring(dist.id);
      setShopViewList(data.shops || []);
    } catch (err: any) {
      setErrorToast(err.message || (lang === 'hi' ? 'दुकानें लोड करने में विफल' : 'Failed to load shops'));
      setShopViewList([]);
    } finally {
      setShopViewLoading(false);
    }
  };
  const [resetPinDistributor, setResetPinDistributor] = useState<Distributor | null>(null);
  const [distPinInput, setDistPinInput] = useState('');
  const [isUpdatingDistPin, setIsUpdatingDistPin] = useState(false);

  // Subscription plans management state
  const [plans, setPlans] = useState<any[]>([]);
  const [editingPlan, setEditingPlan] = useState<any | null>(null);
  const [showAddPlanModal, setShowAddPlanModal] = useState(false);
  const [planForm, setPlanForm] = useState<{
    id: string;
    name: string;
    name_hi: string;
    monthly_fee: number;
    yearly_fee: number;
    max_shops: number;
    description: string;
    description_en: string;
    features_hi: string;
    features_en: string;
    popular: boolean;
  }>({
    id: '',
    name: '',
    name_hi: '',
    monthly_fee: 999,
    yearly_fee: 9990,
    max_shops: 30,
    description: '',
    description_en: '',
    features_hi: '',
    features_en: '',
    popular: false,
  });
  const [savingPlan, setSavingPlan] = useState(false);

  // Feedback states
  const [modalError, setModalError] = useState('');
  const [successToast, setSuccessToast] = useState('');
  const [errorToast, setErrorToast] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const loadData = async () => {
    try {
      const [m, d, p, st, pl] = await Promise.all([
        api.getSuperAdminMetrics(),
        api.getDistributors(),
        api.getSubscriptionPayments(),
        api.getSettings(),
        api.getSubscriptionPlans(),
      ]);
      let activeDists: any[] = [];
      if (d && Array.isArray(d)) {
        let isDemoDel = false;
        let localDelSet = new Set<string>();
        try {
          isDemoDel = localStorage.getItem('vedirt_demo_deleted') === '1';
          const stored = localStorage.getItem('vedirt_deleted_distributors');
          if (stored) {
            const parsed = JSON.parse(stored) as string[];
            // Strip short numeric SQLite IDs ("1", "2", "3") so auto-increment IDs never hide newly created distributors
            const validMobs = parsed.filter((x) => String(x).length >= 10 || isNaN(Number(x)));
            if (validMobs.length !== parsed.length) {
              localStorage.setItem('vedirt_deleted_distributors', JSON.stringify(validMobs));
            }
            localDelSet = new Set(validMobs);
          }
        } catch (e) {}

        const ghostDistsToPurge: any[] = [];
        activeDists = d.filter(
          (item: any) => {
            if (!item) return false;
            if (item.subscription_status === 'deleted' || (item as any).is_deleted === 1 || (item as any).is_deleted === true) return false;
            const mob = String(item.mobile || '').replace(/\D/g, '');
            const mob10 = mob.slice(-10);
            const id = String(item.id || '');
            const isDeletedByMob = (mob.length >= 10 && localDelSet.has(mob)) || (mob10.length >= 10 && localDelSet.has(mob10)) || sessionDeletedDists.current.has(id) || (mob && sessionDeletedDists.current.has(mob));
            const isDeletedDemo = isDemoDel && (mob10 === '9876543210' || item.is_demo === 1 || String(item.business_name || '').includes('श्री गणेश'));
            if (isDeletedByMob || isDeletedDemo) {
              ghostDistsToPurge.push(item);
              return false;
            }
            return true;
          }
        );

        // If backend SQLite returned ghost distributors that were already deleted by the user, purge them from SQLite & Firestore immediately
        if (ghostDistsToPurge.length > 0) {
          Promise.all(
            ghostDistsToPurge.map((g) => api.deleteDistributor(g.id, g.mobile, (g as any).firestore_id).catch(() => {}))
          ).catch(() => {});
        }

        setDistributors((prev) => {
          const map = new Map();
          (prev || []).forEach((item) => {
            if (item && item.subscription_status !== 'deleted' && (item as any).is_deleted !== 1) {
              const cleanMob = String(item.mobile || '').replace(/\D/g, '').slice(-10);
              if (cleanMob && localDelSet.has(cleanMob)) return;
              const key = cleanMob || String(item.id);
              map.set(key, item);
            }
          });
          activeDists.forEach((item: any) => {
            const cleanMob = String(item.mobile || '').replace(/\D/g, '').slice(-10);
            const key = cleanMob || String(item.id);
            const existing = map.get(key) || {};
            const finalShopsCount = (typeof item.shops_count === 'number' && item.shops_count > 0)
              ? item.shops_count
              : (existing.shops_count || item.shops_count || 0);
            map.set(key, { ...existing, ...item, shops_count: finalShopsCount });
          });
          return Array.from(map.values());
        });
      }

      // Keep top metrics cards 100% consistent with active non-deleted distributors
      const activeDistIds = new Set(activeDists.map((item: any) => Number(item.id)));
      const activeCount = activeDists.filter((item: any) => item.subscription_status === 'active').length;
      const trialCount = activeDists.filter((item: any) => item.subscription_status === 'trial').length;
      const expiredCount = activeDists.filter((item: any) => item.subscription_status === 'expired' || item.subscription_status === 'suspended').length;
      const computedMrr = activeDists
        .filter((item: any) => item.subscription_status === 'active')
        .reduce((sum: number, item: any) => sum + (Number(item.monthly_fee) || 0), 0);

      setMetrics({
        ...(m || {}),
        total_distributors: activeDists.length,
        active_distributors: activeCount,
        trial_distributors: trialCount,
        expired_distributors: expiredCount,
        total_mrr: computedMrr,
        total_shops_network: activeDists.length === 0 ? 0 : (m?.total_shops_network || 0),
        total_today_orders: activeDists.length === 0 ? 0 : (m?.total_today_orders || 0),
        total_today_sales: activeDists.length === 0 ? 0 : (m?.total_today_sales || 0),
        renewals_due_this_week: activeDists.length === 0 ? 0 : (m?.renewals_due_this_week || 0),
      });

      const validPayments = Array.isArray(p)
        ? p.filter((pay: any) => activeDistIds.has(Number(pay.distributor_id)))
        : [];
      setPayments(validPayments);
      if (pl && Array.isArray(pl)) setPlans(pl);
      if (st) {
        if (st.platform_upi_id) setPlatformUpi(st.platform_upi_id);
        if (st.platform_qr_image) setPlatformQrImage(st.platform_qr_image);
        if (st.platform_owner_name) setPlatformOwner(st.platform_owner_name);
      }
    } catch (err: any) {
      console.error(err);
      setErrorToast(err.message || 'डेटा लोड करने में विफल');
    } finally {
      setLoading(false);
    }
  };

  const handleEditPlan = (plan: any) => {
    setEditingPlan(plan);
    setPlanForm({
      id: plan.id,
      name: plan.name || '',
      name_hi: plan.name_hi || '',
      monthly_fee: plan.monthly_fee || 0,
      yearly_fee: plan.yearly_fee || 0,
      max_shops: plan.max_shops || 0,
      description: plan.description || '',
      description_en: plan.description_en || '',
      features_hi: Array.isArray(plan.features_hi) ? plan.features_hi.join('\n') : (plan.features_hi || ''),
      features_en: Array.isArray(plan.features_en) ? plan.features_en.join('\n') : (plan.features_en || ''),
      popular: Boolean(plan.popular),
    });
  };

const handleApproveSubPayment = async (payId: number) => {
    try {
      setActionLoading(true);
      const res = await api.approveSubscriptionPayment(payId);
      setSuccessToast(res.message || (lang === 'hi' ? 'भुगतान स्वीकृत कर दिया गया है!' : 'Payment approved successfully!'));
      await loadData();
    } catch (err: any) {
      setErrorToast(err.message || (lang === 'hi' ? 'स्वीकृत करने में विफल' : 'Failed to approve payment'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectSubPayment = async (payId: number) => {
    try {
      setActionLoading(true);
      const res = await api.rejectSubscriptionPayment(payId);
      setSuccessToast(res.message || (lang === 'hi' ? 'भुगतान अनुरोध अस्वीकार किया गया' : 'Payment request rejected'));
      await loadData();
    } catch (err: any) {
      setErrorToast(err.message || (lang === 'hi' ? 'अस्वीकार करने में विफल' : 'Failed to reject payment'));
    } finally {
      setActionLoading(false);
    }
  };
  const handleOpenAddPlan = () => {
    setShowAddPlanModal(true);
    setPlanForm({
      id: 'custom_' + Date.now().toString(36),
      name: 'Custom Plan',
      name_hi: 'कस्टम प्लान',
      monthly_fee: 1499,
      yearly_fee: 14990,
      max_shops: 50,
      description: 'विशेष वितरकों के लिए कस्टमाइज्ड प्लान',
      description_en: 'Custom tailored plan for specific distributors',
      features_hi: '50 दुकानों तक का नेटवर्क\nदैनिक मांग समेकन\nव्हाट्सएप बिलिंग व पर्चियां',
      features_en: 'Up to 50 Retailer Shops\nDaily Demand Summary\nWhatsApp Invoicing & Slips',
      popular: false,
    });
  };

  const handleSavePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!planForm.id || !planForm.name) return;
    setSavingPlan(true);
    try {
      const featsHi = planForm.features_hi.split('\n').map(s => s.trim()).filter(Boolean);
      const featsEnRaw = planForm.features_en.split('\n').map(s => s.trim()).filter(Boolean);
      const featsEn = featsEnRaw.length > 0 ? featsEnRaw : featsHi;
      const descHi = planForm.description.trim();
      const descEn = (planForm.description_en || '').trim() || descHi;
      if (showAddPlanModal) {
        await api.createSubscriptionPlan({
          id: planForm.id,
          name: planForm.name,
          name_hi: planForm.name_hi || planForm.name,
          monthly_fee: Number(planForm.monthly_fee),
          yearly_fee: Number(planForm.yearly_fee),
          max_shops: Number(planForm.max_shops),
          description: descHi,
          description_en: descEn,
          features_hi: featsHi,
          features_en: featsEn,
          popular: planForm.popular,
        });
        setSuccessToast(lang === 'hi' ? 'नया प्लान सफलतापूर्वक बनाया गया!' : 'New plan created successfully!');
        setShowAddPlanModal(false);
      } else {
        await api.updateSubscriptionPlan(planForm.id, {
          name: planForm.name,
          name_hi: planForm.name_hi || planForm.name,
          monthly_fee: Number(planForm.monthly_fee),
          yearly_fee: Number(planForm.yearly_fee),
          max_shops: Number(planForm.max_shops),
          description: descHi,
          description_en: descEn,
          features_hi: featsHi,
          features_en: featsEn,
          popular: planForm.popular,
        });
        setSuccessToast(lang === 'hi' ? 'सब्सक्रिप्शन प्लान की कीमतें सफलतापूर्वक अपडेट हो गईं!' : 'Subscription plan updated successfully!');
        setEditingPlan(null);
      }
      const updatedPlans = await api.getSubscriptionPlans();
      setPlans(updatedPlans);
    } catch (err: any) {
      setErrorToast(err.message || 'प्लान अपडेट करने में विफल');
    } finally {
      setSavingPlan(false);
    }
  };

  const handlePlatformQrUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
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
            setPlatformQrImage(canvas.toDataURL('image/jpeg', 0.85));
          } else {
            setPlatformQrImage(ev.target?.result as string);
          }
        };
        img.src = ev.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSavePlatformQr = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPlatformQr(true);
    setPlatformQrSavedMsg('');
    try {
      await api.updatePlatformQr({
        platform_upi_id: platformUpi.trim(),
        platform_qr_image: platformQrImage,
        platform_owner_name: platformOwner.trim(),
      });
      setPlatformQrSavedMsg(lang === 'hi' ? 'प्लेटफॉर्म QR कोड व UPI आईडी सुरक्षित हो गई!' : 'Platform QR & UPI saved successfully!');
      setTimeout(() => setPlatformQrSavedMsg(''), 4000);
    } catch (err: any) {
      setPlatformQrSavedMsg(err.message || 'त्रुटि (Error)');
    } finally {
      setSavingPlatformQr(false);
    }
  };

  const handleOpenMonitoring = async (distId: number) => {
    setSelectedMonitorDistributorId(distId);
    setActiveTab('monitor');
    setLoadingMonitoring(true);
    setMonitoringShopSearch('');
    setMonitoringRouteFilter('all');
    try {
      const data = await api.getDistributorMonitoring(distId);
      setMonitoringData(data);
    } catch (err: any) {
      setErrorToast(err.message || 'निगरानी डेटा लोड करने में विफल');
    } finally {
      setLoadingMonitoring(false);
    }
  };

  const handleToggleDistributorStatus = async (dist: Distributor) => {
    const nextStatus: SubscriptionStatus = dist.subscription_status === 'suspended' ? 'active' : 'suspended';
    try {
      setStatusTogglingId(dist.id);
      await api.setDistributorStatus(dist.id, nextStatus, dist.mobile, (dist as any).firestore_id);
      // update state optimistically
      setDistributors((prev) =>
        prev.map((d) => (d.id === dist.id || String(d.mobile) === String(dist.mobile) ? { ...d, subscription_status: nextStatus, active_status: nextStatus === 'suspended' ? 0 : 1 } : d))
      );
      if (monitoringData && monitoringData.distributor.id === dist.id) {
        setMonitoringData({
          ...monitoringData,
          distributor: {
            ...monitoringData.distributor,
            subscription_status: nextStatus,
          },
        });
      }
      setSuccessToast(
        nextStatus === 'active'
          ? (lang === 'hi' ? `वितरक "${dist.business_name}" सक्रिय कर दिया गया है` : `Distributor "${dist.business_name}" activated`)
          : (lang === 'hi' ? `वितरक "${dist.business_name}" निलंबित कर दिया गया है` : `Distributor "${dist.business_name}" suspended`)
      );
      loadData();
    } catch (err: any) {
      setErrorToast(err.message || 'स्थिति बदलने में विफल');
    } finally {
      setStatusTogglingId(null);
    }
  };

  useEffect(() => {
    loadData();
    const unsub = subscribeToFirestoreDistributors((cloudDists) => {
      if (cloudDists && Array.isArray(cloudDists)) {
        setDistributors((prev) => {
          // Preserve all active local SQLite distributors and their computed metrics (shops_count, today_orders_count, today_sales_amount)
          const map = new Map();
          (prev || [])
            .filter(
              (d) =>
                d &&
                d.subscription_status !== 'deleted' &&
                (d as any).is_deleted !== 1 &&
                (d as any).is_deleted !== true
            )
            .forEach((d) => {
              const cleanMob = String(d.mobile || '').replace(/\D/g, '').slice(-10);
              const key = cleanMob || String(d.id);
              map.set(key, d);
            });

          // Merge active distributors from Firebase without wiping SQLite computed stats
          cloudDists
            .filter(
              (d: any) => {
                if (!d) return false;
                if (d.subscription_status === 'deleted' || (d as any).is_deleted === 1 || (d as any).is_deleted === true) return false;
                const dMob = String(d.mobile || '').replace(/\D/g, '');
                const dId = String(d.id || '');
                const dFId = String(d.firestore_id || '');

                let isDemoDel = false;
                let localDel = new Set<string>();
                try {
                  isDemoDel = localStorage.getItem('vedirt_demo_deleted') === '1';
                  const stored = localStorage.getItem('vedirt_deleted_distributors');
                  if (stored) {
                    const parsed = (JSON.parse(stored) as string[]).filter((x) => String(x).length >= 10 || isNaN(Number(x)));
                    localDel = new Set(parsed);
                  }
                } catch (e) {}

                const dMob10 = dMob.slice(-10);
                if ((dMob.length >= 10 && localDel.has(dMob)) || (dMob10.length >= 10 && localDel.has(dMob10)) || (dFId.length >= 10 && localDel.has(dFId))) return false;
                if ((dMob && sessionDeletedDists.current.has(dMob)) || (dId && sessionDeletedDists.current.has(dId)) || (dFId && sessionDeletedDists.current.has(dFId))) {
                  return false;
                }
                if (isDemoDel && (dMob === '9876543210' || d.is_demo === 1 || String(d.business_name || '').includes('श्री गणेश'))) {
                  return false;
                }
                return true;
              }
            )
            .forEach((d: any) => {
              const cleanMob = String(d.mobile || '').replace(/\D/g, '').slice(-10);
              const key = cleanMob || String(d.id);
              const existing = map.get(key) || {};
              const existingShopsCount = typeof existing.shops_count === 'number' && existing.shops_count > 0 ? existing.shops_count : (typeof d.shops_count === 'number' ? d.shops_count : (existing.shops_count || 0));
              const existingOrdersCount = typeof existing.today_orders_count === 'number' && existing.today_orders_count > 0 ? existing.today_orders_count : (typeof d.today_orders_count === 'number' ? d.today_orders_count : (existing.today_orders_count || 0));
              const existingSalesAmount = typeof existing.today_sales_amount === 'number' && existing.today_sales_amount > 0 ? existing.today_sales_amount : (typeof d.today_sales_amount === 'number' ? d.today_sales_amount : (existing.today_sales_amount || 0));

              map.set(key, {
                ...existing,
                ...d,
                id: existing.id || d.id || d.firestore_id || Date.now(),
                business_name: d.business_name || existing.business_name || 'Distributor',
                owner_name: d.owner_name || existing.owner_name || 'Owner',
                mobile: String(d.mobile || existing.mobile || '').trim(),
                city: d.city || existing.city || '',
                plan_name: d.plan_name || existing.plan_name || 'Growth Pro',
                subscription_status: d.subscription_status || existing.subscription_status || (d.active_status === 0 ? 'suspended' : 'active'),
                shops_count: existingShopsCount,
                today_orders_count: existingOrdersCount,
                today_sales_amount: existingSalesAmount,
                login_pin: existing.login_pin || d.login_pin || d.pin || '1234',
              });
            });
          return Array.from(map.values());
        });
      }
    });

    const unsubShops = subscribeToFirestoreShops((cloudShops) => {
      if (cloudShops && Array.isArray(cloudShops)) {
        const countsMap = new Map<string, number>();
        cloudShops.forEach((s: any) => {
          if (s && s.active_status !== 0 && !s.is_deleted && s.distributor_id) {
            const k = String(s.distributor_id).trim();
            countsMap.set(k, (countsMap.get(k) || 0) + 1);
          }
        });

        setDistributors((prev) =>
          prev.map((d) => {
            const countById = countsMap.get(String(d.id));
            const countByMobile = d.mobile ? countsMap.get(String(d.mobile).replace(/\D/g, '').slice(-10)) : undefined;
            const countByFId = (d as any).firestore_id ? countsMap.get(String((d as any).firestore_id)) : undefined;
            const liveCount = countById ?? countByMobile ?? countByFId;
            if (liveCount !== undefined) {
              return { ...d, shops_count: liveCount };
            }
            return d;
          })
        );
      }
    });

    return () => {
      unsub();
      unsubShops();
    };
  }, []);

  useEffect(() => {
    if (successToast || errorToast) {
      const timer = setTimeout(() => {
        setSuccessToast('');
        setErrorToast('');
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [successToast, errorToast]);

  // Filtered distributors
  const filteredDistributors = distributors.filter((d) => {
    if (!d) return false;
    if (d.subscription_status === 'deleted' || (d as any).is_deleted === 1 || (d as any).is_deleted === true) return false;
    const q = (searchQuery || '').toLowerCase().trim();
    const matchQuery =
      !q ||
      String(d.business_name || '').toLowerCase().includes(q) ||
      String(d.owner_name || '').toLowerCase().includes(q) ||
      String(d.mobile || '').includes(q) ||
      String(d.city || '').toLowerCase().includes(q);

    const matchStatus = statusFilter === 'all' || d.subscription_status === statusFilter;
    const matchPlan =
      planFilter === 'all' ||
      String(d.plan_name || '').toLowerCase() === planFilter.toLowerCase() ||
      String(d.plan_name || '').toLowerCase().includes(planFilter.toLowerCase());

    return matchQuery && matchStatus && matchPlan;
  });

  const getStatusBadge = (status: SubscriptionStatus) => {
    switch (status) {
      case 'active':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-black bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
            <span>{getSubscriptionStatusName('active', lang)}</span>
          </span>
        );
      case 'trial':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-black bg-amber-100 text-amber-800 border border-amber-200">
            <Clock className="w-3 h-3 text-amber-600" />
            <span>{getSubscriptionStatusName('trial', lang)}</span>
          </span>
        );
      case 'expired':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-black bg-rose-100 text-rose-800 border border-rose-200">
            <AlertTriangle className="w-3 h-3 text-rose-600" />
            <span>{getSubscriptionStatusName('expired', lang)}</span>
          </span>
        );
      case 'suspended':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-black bg-slate-200 text-slate-800 border border-slate-300">
            <PauseCircle className="w-3 h-3 text-slate-600" />
            <span>{getSubscriptionStatusName('suspended', lang)}</span>
          </span>
        );
      default:
        return null;
    }
  };

  const getPlanBadge = (planName?: string) => {
    const p = String(planName || '');
    let color = 'bg-sky-50 text-sky-800 border-sky-200';
    if (p.includes('Enterprise')) color = 'bg-purple-50 text-purple-800 border-purple-200';
    if (p.includes('Business') || p.includes('Pro'))
      color = 'bg-emerald-50 text-emerald-800 border-emerald-200';

    return (
      <span className={`px-2 py-0.5 rounded-lg text-[10px] font-extrabold uppercase border ${color}`}>
        {planName || 'Standard'}
      </span>
    );
  };

  const getDaysRemainingText = (renewalDateStr: string) => {
    if (!renewalDateStr) return '';
    const now = new Date();
    const ren = new Date(renewalDateStr);
    const diffDays = Math.ceil((ren.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return (
        <span className="text-rose-600 font-bold">
          {Math.abs(diffDays)} {t.overdueByDays}
        </span>
      );
    }
    if (diffDays <= 7) {
      return (
        <span className="text-amber-700 font-bold">
          {diffDays} {t.daysLeft}
        </span>
      );
    }
    return (
      <span className="text-slate-500 font-medium">
        {diffDays} {t.daysLeft}
      </span>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-6 space-y-6">
      {/* Toast notifications */}
      {successToast && (
        <div className="fixed top-20 right-4 z-50 bg-emerald-800 text-white px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2 text-xs font-bold animate-in fade-in slide-in-from-top-4">
          <CheckCircle2 className="w-4 h-4 text-emerald-300" />
          <span>{successToast}</span>
        </div>
      )}
      {errorToast && (
        <div className="fixed top-20 right-4 z-50 bg-rose-700 text-white px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2 text-xs font-bold animate-in fade-in slide-in-from-top-4">
          <AlertTriangle className="w-4 h-4 text-amber-300" />
          <span>{errorToast}</span>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* HEADER BANNER */}
      {/* ------------------------------------------------------------- */}
      <div className="bg-gradient-to-r from-slate-900 via-emerald-950 to-slate-900 rounded-3xl p-5 sm:p-7 text-white shadow-xl relative overflow-hidden border border-emerald-900/40">
        <div className="absolute right-0 top-0 bottom-0 w-1/3 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-500/20 via-transparent to-transparent pointer-events-none" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 text-xs font-extrabold mb-2.5">
              <Shield className="w-3.5 h-3.5" />
              <span>{lang === 'hi' ? 'कंपनी फाउंडर / सुपर एडमिन' : 'Company Founder & Platform Super Admin'}</span>
            </div>
            <h1 className="text-xl sm:text-3xl font-black tracking-tight flex items-center gap-2.5">
              <span>{t.superAdminDashboard}</span>
            </h1>
            <p className="text-xs sm:text-sm text-emerald-100/70 mt-1 max-w-2xl leading-relaxed">
              {lang === 'hi'
                ? 'विभिन्न क्षेत्रों के थोक वितरकों (FMCG, बेकरी, किराना, पेय, डेयरी आदि) का ऑनबोर्डिंग, मासिक बिलिंग और रिटेलर नेटवर्क का केंद्रीय प्रबंधन।'
                : 'Centralized management of multi-city B2B wholesale distributors, subscription billing, and shopkeeper networks.'}
            </p>
          </div>

          <div className="flex items-center gap-2.5 shrink-0 flex-wrap">

            <button
              onClick={() => {
                setModalError('');
                setShowAddModal(true);
              }}
              className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs sm:text-sm shadow-lg shadow-emerald-500/20 transition-all active:scale-95"
            >
              <Plus className="w-4 h-4 stroke-[3]" />
              <span>{t.addNewDistributor}</span>
            </button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* SAAS PLATFORM METRICS CARDS */}
      {/* ------------------------------------------------------------- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* MRR */}
        <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
              {t.mrr}
            </span>
            <div className="p-2 rounded-2xl bg-emerald-50 text-emerald-700">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            {loading && !metrics ? (
              <div className="space-y-2">
                <div className="h-8 w-28 bg-slate-100 animate-pulse rounded-xl" />
                <div className="h-3.5 w-36 bg-slate-100 animate-pulse rounded-md" />
              </div>
            ) : (
              <>
                <div className="text-2xl sm:text-3xl font-black text-emerald-900 tracking-tight">
                  {formatCurrency(metrics?.total_mrr || 0)}
                  <span className="text-xs text-slate-400 font-bold ml-1">/ mo</span>
                </div>
                <div className="text-[11px] text-slate-500 font-semibold mt-1">
                  {metrics?.active_distributors || 0} {lang === 'hi' ? 'वितरकों से आवर्ती राजस्व' : 'active paying distributors'}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Distributors Overview */}
        <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
              {t.totalDistributors}
            </span>
            <div className="p-2 rounded-2xl bg-sky-50 text-sky-700">
              <Building2 className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            {loading && !metrics ? (
              <div className="space-y-2">
                <div className="h-8 w-16 bg-slate-100 animate-pulse rounded-xl" />
                <div className="h-3.5 w-40 bg-slate-100 animate-pulse rounded-md" />
              </div>
            ) : (
              <>
                <div className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
                  {distributors.length === 0 && !metrics ? 0 : (metrics?.total_distributors ?? distributors.length)}
                </div>
                <div className="text-[11px] text-slate-500 font-semibold mt-1 flex items-center gap-1.5 flex-wrap">
                  <span className="text-emerald-700 font-bold">
                    {metrics?.active_distributors || 0} {lang === 'hi' ? 'सक्रिय' : 'Active'}
                  </span>
                  <span>•</span>
                  <span className="text-amber-700 font-bold">
                    {metrics?.trial_distributors || 0} {lang === 'hi' ? 'ट्रायल' : 'Trial'}
                  </span>
                  <span>•</span>
                  <span className="text-rose-700 font-bold">
                    {metrics?.expired_distributors || 0} {lang === 'hi' ? 'अवधि समाप्त' : 'Expired'}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Network Shops */}
        <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
              {t.totalNetworkShops}
            </span>
            <div className="p-2 rounded-2xl bg-amber-50 text-amber-700">
              <Store className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            {loading && !metrics ? (
              <div className="space-y-2">
                <div className="h-8 w-20 bg-slate-100 animate-pulse rounded-xl" />
                <div className="h-3.5 w-44 bg-slate-100 animate-pulse rounded-md" />
              </div>
            ) : (
              <>
                <div className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
                  {metrics?.total_shops_network || 0}
                </div>
                <div className="text-[11px] text-slate-500 font-semibold mt-1">
                  {lang === 'hi' ? 'सभी वितरकों के कुल खुदरा दुकानदार' : 'Retailer shops across all routes'}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Daily Volume Processed */}
        <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
              {t.totalPlatformSales}
            </span>
            <div className="p-2 rounded-2xl bg-purple-50 text-purple-700">
              <PackageCheck className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            {loading && !metrics ? (
              <div className="space-y-2">
                <div className="h-8 w-28 bg-slate-100 animate-pulse rounded-xl" />
                <div className="h-3.5 w-36 bg-slate-100 animate-pulse rounded-md" />
              </div>
            ) : (
              <>
                <div className="text-2xl sm:text-3xl font-black text-purple-950 tracking-tight">
                  {formatCurrency(metrics?.total_today_sales || 0)}
                </div>
                <div className="text-[11px] text-slate-500 font-semibold mt-1">
                  {metrics?.total_today_orders || 0} {t.todayOrders} ({metrics?.renewals_due_this_week || 0} {t.renewalsDueThisWeek})
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* TABS NAVIGATION */}
      {/* ------------------------------------------------------------- */}
      <div className="flex border-b border-slate-200 gap-2 sm:gap-4 overflow-x-auto pb-1">
        <button
          onClick={() => setActiveTab('distributors')}
          className={`pb-3 px-3 text-xs sm:text-sm font-extrabold border-b-2 flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'distributors'
              ? 'border-emerald-700 text-emerald-800'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Building2 className="w-4 h-4" />
          <span>{t.distributorManagement} ({distributors.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('network_orders')}
          className={`pb-3 px-3 text-xs sm:text-sm font-extrabold border-b-2 flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'network_orders'
              ? 'border-emerald-700 text-emerald-800'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Package className="w-4 h-4 text-emerald-700" />
          <span>{lang === 'hi' ? '📦 नेटवर्क ऑर्डर्स व आइटम विवरण (Qty/Price)' : '📦 Network Orders & Items (Qty/Price)'}</span>
        </button>

        <button
          onClick={() => {
            setActiveTab('monitor');
            if (!selectedMonitorDistributorId && distributors.length > 0) {
              handleOpenMonitoring(distributors[0].id);
            }
          }}
          className={`pb-3 px-3 text-xs sm:text-sm font-extrabold border-b-2 flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'monitor'
              ? 'border-emerald-700 text-emerald-800'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Activity className="w-4 h-4 text-emerald-600" />
          <span className="flex items-center gap-1.5">
            <span>{t.monitorDistributors}</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          </span>
        </button>

        <button
          onClick={() => setActiveTab('billing')}
          className={`pb-3 px-3 text-xs sm:text-sm font-extrabold border-b-2 flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'billing'
              ? 'border-emerald-700 text-emerald-800'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <CreditCard className="w-4 h-4" />
          <span>{t.subscriptionPaymentsHistory} ({payments.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('plans')}
          className={`pb-3 px-3 text-xs sm:text-sm font-extrabold border-b-2 flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'plans'
              ? 'border-emerald-700 text-emerald-800'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Sparkles className="w-4 h-4" />
          <span>{lang === 'hi' ? 'प्लान्स व मूल्य निर्धारण (SaaS Tiers)' : 'Pricing Tiers & Limits'}</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`pb-3 px-3 text-xs sm:text-sm font-extrabold border-b-2 flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'settings'
              ? 'border-emerald-700 text-emerald-800'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <QrCode className="w-4 h-4 text-emerald-700" />
          <span>{lang === 'hi' ? '💳 पेमेंट QR व UPI सेटिंग्स' : '💳 Platform Payment QR & UPI'}</span>
        </button>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* TAB 1: DISTRIBUTORS MANAGEMENT */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'distributors' && (
        <div className="space-y-4">
          {/* Filters Bar & View Mode Toggle */}
          <div className="bg-white p-4 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder={lang === 'hi' ? 'वितरक, शहर, संचालक या मोबाइल नंबर खोजें...' : 'Search distributor, city, owner or phone...'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-2xl border border-slate-200 text-xs sm:text-sm focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
              />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 rounded-2xl border border-slate-200 text-xs font-bold text-slate-700 bg-slate-50"
              >
                <option value="all">{lang === 'hi' ? 'सभी स्थिति (All Status)' : 'All Status'}</option>
                <option value="active">{getSubscriptionStatusName('active', lang)}</option>
                <option value="trial">{getSubscriptionStatusName('trial', lang)}</option>
                <option value="expired">{getSubscriptionStatusName('expired', lang)}</option>
                <option value="suspended">{getSubscriptionStatusName('suspended', lang)}</option>
              </select>

              <select
                value={planFilter}
                onChange={(e) => setPlanFilter(e.target.value)}
                className="px-3 py-2 rounded-2xl border border-slate-200 text-xs font-bold text-slate-700 bg-slate-50"
              >
                <option value="all">{lang === 'hi' ? 'सभी प्लान (All Plans)' : 'All Plans'}</option>
                {Array.from(
                  new Set([
                    ...plans.map((p) => p.name).filter(Boolean),
                    ...distributors.map((d) => d.plan_name).filter(Boolean),
                  ])
                ).map((pName) => (
                  <option key={pName} value={pName}>
                    {pName}
                  </option>
                ))}
              </select>

              {/* View Mode Toggle: Grid vs Table */}
              <div className="flex items-center bg-slate-100 p-1 rounded-2xl border border-slate-200">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${
                    viewMode === 'grid'
                      ? 'bg-white text-emerald-800 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                  title={t.cardView}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t.cardView}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('table')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${
                    viewMode === 'table'
                      ? 'bg-white text-emerald-800 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                  title={t.tableView}
                >
                  <List className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t.tableView}</span>
                </button>
              </div>
            </div>
          </div>

          {/* VIEW MODE 1: GRID VIEW */}
          {viewMode === 'grid' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredDistributors.map((dist, idx) => {
                const shopUsagePct = dist.max_shops > 0 ? Math.min(100, Math.round(((dist.shops_count || 0) / dist.max_shops) * 100)) : 0;
                const isNearLimit = shopUsagePct >= 85;

                return (
                  <div
                    key={`sa-dist-grid-${dist.id ?? idx}-${idx}`}
                    className="bg-white rounded-3xl border border-slate-200/90 shadow-xs hover:shadow-md transition-all flex flex-col justify-between overflow-hidden"
                  >
                    {/* Header */}
                    <div className="p-5 border-b border-slate-100 bg-slate-50/50 flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-black text-slate-900 tracking-tight">
                            {dist.business_name}
                          </h3>
                          {getPlanBadge(dist.plan_name)}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-500 font-semibold mt-1">
                          <MapPin className="w-3.5 h-3.5 text-slate-400" />
                          <span>{dist.city}</span>
                          <span>•</span>
                          <span className="text-slate-700 font-bold">{dist.owner_name}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {getStatusBadge(dist.subscription_status)}
                        {/* Quick 1-click status toggle switch */}
                        <button
                          type="button"
                          disabled={statusTogglingId === dist.id}
                          onClick={() => handleToggleDistributorStatus(dist)}
                          className={`p-1.5 rounded-xl border text-xs font-bold flex items-center gap-1 transition ${
                            dist.subscription_status === 'suspended'
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                          } disabled:opacity-50`}
                          title={dist.subscription_status === 'suspended' ? t.reactivateDistributor : t.suspendDistributor}
                        >
                          {statusTogglingId === dist.id ? (
                            <span className="w-3.5 h-3.5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                          ) : dist.subscription_status === 'suspended' ? (
                            <PlayCircle className="w-3.5 h-3.5 text-emerald-600" />
                          ) : (
                            <PauseCircle className="w-3.5 h-3.5 text-slate-500" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Body Details */}
                    <div className="p-5 space-y-4 text-xs">
                      {/* Contact row */}
                      <div className="grid grid-cols-2 gap-2 text-slate-600">
                        <div className="flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 text-slate-400" />
                          <span className="font-mono font-bold text-slate-800">{dist.mobile}</span>
                        </div>
                        <div className="flex items-center gap-1.5 truncate">
                          <Mail className="w-3.5 h-3.5 text-slate-400" />
                          <span className="truncate">{dist.email}</span>
                        </div>
                      </div>

                      {/* Distributor Security PIN & WhatsApp Share */}
                      <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                          <KeyRound className="w-3.5 h-3.5 text-emerald-700" />
                          <span className="text-[11px] text-slate-500 font-bold">{lang === 'hi' ? 'लॉगिन पिन:' : 'PIN:'}</span>
                          <span className="font-mono font-black text-slate-900 bg-white px-2 py-0.5 rounded-md border border-slate-200 text-xs">
                            {dist.login_pin || '1234'}
                          </span>
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              setResetPinDistributor(dist);
                              setDistPinInput(dist.login_pin || '1234');
                            }}
                            className="px-2 py-1 rounded-lg text-slate-600 hover:text-emerald-700 hover:bg-white text-[11px] font-bold border border-transparent hover:border-slate-200 transition flex items-center gap-1"
                            title={lang === 'hi' ? 'पिन बदलें' : 'Reset PIN'}
                          >
                            <KeyRound className="w-3 h-3" />
                            <span>{lang === 'hi' ? 'पिन बदलें' : 'Reset'}</span>
                          </button>

                          <a
                            href={`https://wa.me/91${String(dist.mobile || '').replace(/\D/g, '').slice(-10)}?text=${encodeURIComponent(
                              `नमस्ते ${dist.owner_name} जी! वेदिरतसेतु में आपकी वितरक आईडी (${dist.business_name}) तैयार है।\nलॉगिन मोबाइल: ${dist.mobile}\nसुरक्षा पिन: ${dist.login_pin || '1234'}\nकृपया ऐप खोलकर लॉगिन करें।`
                            )}`}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1 rounded-lg text-emerald-700 hover:bg-emerald-50 transition"
                            title={lang === 'hi' ? 'व्हाट्सएप पर क्रेडेंशियल्स भेजें' : 'Send ID & PIN via WhatsApp'}
                          >
                            <MessageCircle className="w-4 h-4" />
                          </a>
                        </div>
                      </div>

                      {/* Operational stats */}
                      <div className="grid grid-cols-3 gap-2 p-3 bg-slate-50 rounded-2xl border border-slate-100 text-center">
                        <div>
                          <div className="text-[10px] text-slate-400 font-black uppercase">
                            {t.associatedShops}
                          </div>
                          <div className="text-sm font-black text-slate-900 mt-0.5">
                            {dist.shops_count || 0}
                            <span className="text-[10px] text-slate-400 font-medium ml-0.5">
                              / {dist.max_shops}
                            </span>
                          </div>
                          {/* Mini shop capacity meter */}
                          <div className="mt-1 w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                isNearLimit ? 'bg-rose-500' : 'bg-emerald-600'
                              }`}
                              style={{ width: `${shopUsagePct}%` }}
                            />
                          </div>
                        </div>

                        <div>
                          <div className="text-[10px] text-slate-400 font-black uppercase">
                            {t.todayOrders}
                          </div>
                          <div className="text-sm font-black text-emerald-800 mt-0.5">
                            {dist.today_orders_count || 0}
                          </div>
                          <div className="text-[10px] text-slate-400 font-medium mt-1">
                            {lang === 'hi' ? 'आज समेकित' : 'today'}
                          </div>
                        </div>

                        <div>
                          <div className="text-[10px] text-slate-400 font-black uppercase">
                            {lang === 'hi' ? 'आज का टर्नओवर' : 'Today Sales'}
                          </div>
                          <div className="text-sm font-black text-slate-900 mt-0.5">
                            {formatCurrency(dist.today_sales_amount || 0)}
                          </div>
                          <div className="text-[10px] text-slate-400 font-medium mt-1">
                            {lang === 'hi' ? 'दुकानों से मांग' : 'demand'}
                          </div>
                        </div>
                      </div>

                      {/* Subscription fee and renewal line */}
                      <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-slate-600">
                        <div>
                          <span className="font-bold text-slate-800">{formatCurrency(dist.monthly_fee)}</span>
                          <span className="text-[10px] text-slate-400 ml-1">/ {lang === 'hi' ? 'मासिक' : 'month'}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px]">
                          <Calendar className="w-3.5 h-3.5 text-slate-400" />
                          <span>{t.renewalDate}: <strong>{dist.subscription_renewal_date}</strong></span>
                          <span className="ml-1">({getDaysRemainingText(dist.subscription_renewal_date)})</span>
                        </div>
                      </div>
                    </div>

                    {/* Actions Footer */}
                    <div className="p-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        {/* View Shops Direct Modal */}
                        <button
                          type="button"
                          onClick={() => handleViewDistributorShops(dist)}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold text-xs transition active:scale-95 shadow-xs"
                          title={lang === 'hi' ? 'दुकानों की सूची देखें' : 'View Registered Shops'}
                        >
                          <Store className="w-3.5 h-3.5 text-emerald-700" />
                          <span>{lang === 'hi' ? 'दुकानें देखें' : 'View Shops'}</span>
                        </button>
                        {/* Open Dedicated Monitor View */}
                        <button
                          type="button"
                          onClick={() => handleOpenMonitoring(dist.id)}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition active:scale-95 shadow-xs"
                          title={t.monitorDistributors}
                        >
                          <Activity className="w-3.5 h-3.5 text-emerald-400" />
                          <span>{t.monitor}</span>
                        </button>

                        {/* Inspect Workspace button */}
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const res = await api.impersonateDistributor(dist.id);
                              onInspectDistributor(res.user, res.token);
                            } catch (err: any) {
                              setErrorToast(err.message || 'वितरक पोर्टल खोलने में असमर्थ');
                            }
                          }}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-xs transition active:scale-95 shadow-xs"
                          title={t.viewDistributorWorkspace}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">{t.viewDistributorWorkspace}</span>
                          <span className="sm:hidden">{lang === 'hi' ? 'पोर्टल' : 'Portal'}</span>
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {/* Record Payment */}
                        <button
                          type="button"
                          onClick={() => {
                            setPaymentDistributor(dist);
                            setModalError('');
                          }}
                          className="px-2.5 py-1.5 rounded-xl border border-emerald-300 text-emerald-800 bg-emerald-50 hover:bg-emerald-100 font-bold text-xs flex items-center gap-1 transition"
                          title={t.recordSubscriptionPayment}
                        >
                          <Receipt className="w-3.5 h-3.5" />
                          <span>{lang === 'hi' ? 'फीस' : 'Fee'}</span>
                        </button>

                        {/* Edit */}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingDistributor(dist);
                            setModalError('');
                          }}
                          className="p-1.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-200 transition"
                          title={t.editDistributor}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete */}
                        <button
                          type="button"
                          onClick={() => setDistributorToDelete(dist)}
                          className="p-1.5 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 transition"
                          title={t.confirmDeleteDistributor}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* VIEW MODE 2: MONITORING TABLE VIEW */}
          {viewMode === 'table' && (
            <div className="bg-white rounded-3xl border border-slate-200/90 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500 font-black uppercase text-[10px] border-b border-slate-200">
                    <tr>
                      <th className="p-3.5">#</th>
                      <th className="p-3.5">{t.distributorName}</th>
                      <th className="p-3.5">{t.subscriptionStatus} & {lang === 'hi' ? 'नियंत्रण' : 'Toggle'}</th>
                      <th className="p-3.5">{t.plan} & {t.shopCapacity}</th>
                      <th className="p-3.5">{t.monthlyFee}</th>
                      <th className="p-3.5">{t.renewalDate}</th>
                      <th className="p-3.5">{t.todayOrders} / {lang === 'hi' ? 'टर्नओवर' : 'Turnover'}</th>
                      <th className="p-3.5 text-right">{lang === 'hi' ? 'कार्यवाही' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium">
                    {filteredDistributors.map((dist, idx) => {
                      const shopUsagePct = dist.max_shops > 0 ? Math.min(100, Math.round(((dist.shops_count || 0) / dist.max_shops) * 100)) : 0;
                      const isNearLimit = shopUsagePct >= 85;

                      return (
                        <tr key={`sa-dist-row-${dist.id ?? idx}-${idx}`} className="hover:bg-slate-50/70 transition">
                          <td className="p-3.5 text-slate-400 font-mono">{idx + 1}</td>
                          <td className="p-3.5">
                            <div className="font-black text-slate-900 text-sm flex items-center gap-1.5">
                              <span>{dist.business_name}</span>
                            </div>
                            <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                              <span className="font-semibold text-slate-700">{dist.owner_name}</span>
                              <span>•</span>
                              <span>{dist.city}</span>
                              <span>•</span>
                              <span className="font-mono text-slate-600">{dist.mobile}</span>
                            </div>
                          </td>

                          {/* Status and 1-Click Toggle */}
                          <td className="p-3.5">
                            <div className="flex items-center gap-2">
                              {getStatusBadge(dist.subscription_status)}
                              <button
                                type="button"
                                disabled={statusTogglingId === dist.id}
                                onClick={() => handleToggleDistributorStatus(dist)}
                                className={`px-2 py-1 rounded-xl text-[11px] font-bold border flex items-center gap-1 transition ${
                                  dist.subscription_status === 'suspended'
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                                    : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
                                } disabled:opacity-50`}
                                title={dist.subscription_status === 'suspended' ? t.reactivateDistributor : t.suspendDistributor}
                              >
                                {statusTogglingId === dist.id ? (
                                  <span className="w-3 h-3 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                                ) : dist.subscription_status === 'suspended' ? (
                                  <>
                                    <PlayCircle className="w-3 h-3 text-emerald-600" />
                                    <span>{t.activate}</span>
                                  </>
                                ) : (
                                  <>
                                    <PauseCircle className="w-3 h-3 text-slate-500" />
                                    <span>{t.deactivate}</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </td>

                          {/* Plan & Shop Capacity Meter */}
                          <td className="p-3.5">
                            <div className="flex items-center gap-2">
                              {getPlanBadge(dist.plan_name)}
                              <span className="font-black text-slate-800">
                                {dist.shops_count || 0} / {dist.max_shops} {lang === 'hi' ? 'दुकानें' : 'shops'}
                              </span>
                            </div>
                            <div className="mt-1.5 w-36 bg-slate-100 rounded-full h-2 overflow-hidden border border-slate-200">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  isNearLimit ? 'bg-rose-500' : 'bg-emerald-600'
                                }`}
                                style={{ width: `${shopUsagePct}%` }}
                              />
                            </div>
                            <div className="text-[10px] text-slate-400 font-semibold mt-0.5">
                              {shopUsagePct}% {lang === 'hi' ? 'क्षमता प्रयुक्त' : 'capacity used'}
                            </div>
                          </td>

                          {/* Fee */}
                          <td className="p-3.5">
                            <span className="font-black text-slate-900 text-sm">
                              {formatCurrency(dist.monthly_fee)}
                            </span>
                            <div className="text-[10px] text-slate-400">/ {lang === 'hi' ? 'माह' : 'month'}</div>
                          </td>

                          {/* Renewal */}
                          <td className="p-3.5">
                            <div className="font-bold text-slate-800 font-mono">{dist.subscription_renewal_date}</div>
                            <div className="text-[11px] mt-0.5">{getDaysRemainingText(dist.subscription_renewal_date)}</div>
                          </td>

                          {/* Today Activity */}
                          <td className="p-3.5">
                            <div className="font-bold text-slate-900">
                              {dist.today_orders_count || 0} {lang === 'hi' ? 'ऑर्डर' : 'orders'}
                            </div>
                            <div className="text-[11px] font-black text-emerald-800">
                              {formatCurrency(dist.today_sales_amount || 0)}
                            </div>
                          </td>

                          {/* Table Actions */}
                          <td className="p-3.5 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              {/* View Shops Direct Modal */}
                              <button
                                type="button"
                                onClick={() => handleViewDistributorShops(dist)}
                                className="px-2.5 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold text-xs flex items-center gap-1 shadow-xs transition"
                                title={lang === 'hi' ? 'दुकानों की सूची देखें' : 'View Registered Shops'}
                              >
                                <Store className="w-3.5 h-3.5 text-emerald-700" />
                                <span>{lang === 'hi' ? 'दुकानें' : 'Shops'}</span>
                              </button>
                              {/* Open Monitor Console */}
                              <button
                                type="button"
                                onClick={() => handleOpenMonitoring(dist.id)}
                                className="px-2.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs flex items-center gap-1 shadow-xs transition"
                                title={t.monitorDistributors}
                              >
                                <Activity className="w-3.5 h-3.5 text-emerald-400" />
                                <span>{t.monitor}</span>
                              </button>

                              {/* Inspect Workspace */}
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    const res = await api.impersonateDistributor(dist.id);
                                    onInspectDistributor(res.user, res.token);
                                  } catch (err: any) {
                                    setErrorToast(err.message || 'वितरक पोर्टल खोलने में असमर्थ');
                                  }
                                }}
                                className="p-1.5 rounded-xl border border-emerald-300 text-emerald-800 bg-emerald-50 hover:bg-emerald-100 transition"
                                title={t.viewDistributorWorkspace}
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </button>

                              {/* Fee */}
                              <button
                                type="button"
                                onClick={() => {
                                  setPaymentDistributor(dist);
                                  setModalError('');
                                }}
                                className="p-1.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 transition"
                                title={t.recordSubscriptionPayment}
                              >
                                <Receipt className="w-3.5 h-3.5" />
                              </button>

                              {/* Edit */}
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingDistributor(dist);
                                  setModalError('');
                                }}
                                className="p-1.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 transition"
                                title={t.editDistributor}
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>

                              {/* Delete */}
                              <button
                                type="button"
                                onClick={() => setDistributorToDelete(dist)}
                                className="p-1.5 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 transition"
                                title={t.confirmDeleteDistributor}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {distributors.length === 0 ? (
            <div className="bg-white p-10 sm:p-14 text-center rounded-3xl border border-slate-200 text-slate-500 space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center mx-auto text-emerald-700 shadow-xs">
                <Building2 className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <h4 className="font-black text-lg text-slate-900">
                  {lang === 'hi' ? 'केवल आपके द्वारा बनाए गए वितरक रहेंगे' : 'No Distributor Accounts Yet'}
                </h4>
                <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                  {lang === 'hi'
                    ? 'डेमो वितरक खाते हटा दिए गए हैं। अब आप जितने वितरक बनाएंगे, केवल वही रहेंगे और हमेशा सुरक्षित सहेजे रहेंगे।'
                    : 'Demo distributor accounts have been removed. Only distributors you create will appear and remain permanently saved.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(true);
                  setModalError('');
                }}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs shadow-md shadow-emerald-700/20 active:scale-95 transition"
              >
                <Plus className="w-4 h-4" />
                <span>{t.addNewDistributor}</span>
              </button>
            </div>
          ) : filteredDistributors.length === 0 ? (
            <div className="bg-white p-12 text-center rounded-3xl border border-slate-200 text-slate-400">
              <Building2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-bold text-sm">
                {lang === 'hi' ? 'कोई वितरक नहीं मिला' : 'No distributors found matching filters'}
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB: DISTRIBUTOR NETWORK ORDERS & ITEMS BREAKDOWN */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'network_orders' && (
        <SuperAdminNetworkOrdersView lang={lang} />
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB: REAL-TIME DISTRIBUTOR & SHOPS NETWORK MONITOR */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'monitor' && (
        <div className="space-y-6">
          {/* Top Distributor Carousel Selector */}
          <div className="bg-white p-4 rounded-3xl border border-slate-200/80 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-700" />
                <h3 className="font-black text-sm text-slate-900">
                  {lang === 'hi' ? 'वितरक चुनें (Select Distributor to Monitor):' : 'Select Distributor to Monitor:'}
                </h3>
              </div>
              <div className="text-xs text-slate-400 font-bold">
                {distributors.length} {lang === 'hi' ? 'पंजीकृत वितरक' : 'registered distributors'}
              </div>
            </div>

            <div className="flex items-center gap-2.5 overflow-x-auto pb-2 scrollbar-thin">
              {distributors.map((d, idx) => {
                const isSelected = selectedMonitorDistributorId === d.id;
                return (
                  <button
                    key={`sa-dist-pill-${d.id ?? idx}-${idx}`}
                    type="button"
                    onClick={() => handleOpenMonitoring(d.id)}
                    className={`flex items-center gap-2.5 px-4 py-2.5 rounded-2xl border text-xs font-bold transition shrink-0 text-left ${
                      isSelected
                        ? 'bg-slate-950 text-white border-slate-950 shadow-md ring-2 ring-emerald-500'
                        : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                    }`}
                  >
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        d.subscription_status === 'active'
                          ? 'bg-emerald-500'
                          : d.subscription_status === 'suspended'
                          ? 'bg-rose-500'
                          : 'bg-amber-500'
                      }`}
                    />
                    <div>
                      <div className="font-black">{d.business_name}</div>
                      <div className={`text-[10px] ${isSelected ? 'text-emerald-300' : 'text-slate-500'}`}>
                        {d.city} • {d.shops_count || 0}/{d.max_shops} {lang === 'hi' ? 'दुकानें' : 'shops'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Monitoring Content */}
          {loadingMonitoring ? (
            <div className="bg-white p-16 rounded-3xl border border-slate-200 text-center space-y-3">
              <div className="w-10 h-10 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="font-bold text-xs text-slate-500">
                {lang === 'hi' ? 'वितरक का लाइव डेटा और दुकान नेटवर्क लोड हो रहा है...' : 'Loading distributor live data and shop network...'}
              </p>
            </div>
          ) : monitoringData ? (
            <div className="space-y-5 animate-in fade-in duration-150">
              {/* Distributor Master Header Card */}
              <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-emerald-950 rounded-3xl p-5 sm:p-6 text-white border border-emerald-800/40 shadow-xl flex flex-col lg:flex-row items-start lg:items-center justify-between gap-5">
                <div>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white">
                      {monitoringData.distributor.business_name}
                    </h2>
                    {getPlanBadge(monitoringData.distributor.plan_name)}
                    {getStatusBadge(monitoringData.distributor.subscription_status)}
                  </div>

                  <div className="flex items-center gap-3 text-xs text-slate-300 font-semibold mt-2 flex-wrap">
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                      {monitoringData.distributor.city}
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Users className="w-3.5 h-3.5 text-emerald-400" />
                      {monitoringData.distributor.owner_name}
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1 font-mono">
                      <Phone className="w-3.5 h-3.5 text-emerald-400" />
                      {monitoringData.distributor.mobile}
                    </span>
                    {monitoringData.distributor.email && (
                      <>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <Mail className="w-3.5 h-3.5 text-emerald-400" />
                          {monitoringData.distributor.email}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Status Toggle & Quick Actions */}
                <div className="flex items-center gap-2.5 flex-wrap w-full lg:w-auto justify-start lg:justify-end">
                  {/* One-click Activate / Suspend Switch */}
                  <button
                    type="button"
                    disabled={statusTogglingId === monitoringData.distributor.id}
                    onClick={() => handleToggleDistributorStatus(monitoringData.distributor)}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-black transition active:scale-95 shadow-md ${
                      monitoringData.distributor.subscription_status === 'suspended'
                        ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                        : 'bg-rose-600 hover:bg-rose-500 text-white'
                    } disabled:opacity-50`}
                  >
                    <Power className="w-4 h-4" />
                    <span>
                      {monitoringData.distributor.subscription_status === 'suspended'
                        ? t.reactivateDistributor
                        : t.suspendDistributor}
                    </span>
                  </button>

                  {/* Impersonate Live Portal */}
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await api.impersonateDistributor(monitoringData.distributor.id);
                        onInspectDistributor(res.user, res.token);
                      } catch (err: any) {
                        setErrorToast(err.message || 'वितरक पोर्टल खोलने में असमर्थ');
                      }
                    }}
                    className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-white/10 hover:bg-white/20 text-white font-black text-xs transition border border-white/20 active:scale-95"
                    title={t.viewDistributorWorkspace}
                  >
                    <ExternalLink className="w-4 h-4 text-emerald-300" />
                    <span>{t.openDistributorPortal}</span>
                  </button>

                  {/* Record Payment */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentDistributor(monitoringData.distributor);
                      setModalError('');
                    }}
                    className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl bg-emerald-700 hover:bg-emerald-600 text-white font-black text-xs transition active:scale-95"
                    title={t.recordSubscriptionPayment}
                  >
                    <Receipt className="w-4 h-4 text-amber-300" />
                    <span>{lang === 'hi' ? 'फीस रसीद' : 'Record Fee'}</span>
                  </button>

                  {/* Edit */}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingDistributor(monitoringData.distributor);
                      setModalError('');
                    }}
                    className="p-2.5 rounded-2xl bg-white/10 hover:bg-white/20 text-white transition border border-white/20"
                    title={t.editDistributor}
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 4 KPI Monitoring Cards for Selected Distributor */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                {/* 1. Shop Capacity Utilization */}
                <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/90 shadow-xs flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                      {t.shopCapacity}
                    </span>
                    <div className="p-2 rounded-2xl bg-emerald-50 text-emerald-700">
                      <Store className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="text-2xl font-black text-slate-900 tracking-tight">
                      {monitoringData.stats.total_shops}{' '}
                      <span className="text-xs text-slate-400 font-bold">
                        / {monitoringData.distributor.max_shops}
                      </span>
                    </div>
                    <div className="mt-2 w-full bg-slate-100 rounded-full h-2 overflow-hidden border border-slate-200">
                      <div
                        className={`h-full rounded-full transition-all ${
                          monitoringData.stats.plan_usage_percentage > 100
                            ? 'bg-rose-600'
                            : monitoringData.stats.plan_usage_percentage >= 85
                            ? 'bg-amber-500'
                            : 'bg-emerald-600'
                        }`}
                        style={{ width: `${Math.min(100, monitoringData.stats.plan_usage_percentage)}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-slate-500 font-semibold mt-1.5 flex items-center justify-between">
                      {monitoringData.stats.plan_usage_percentage > 100 ? (
                        <span className="text-rose-600 font-black animate-pulse">
                          {monitoringData.stats.plan_usage_percentage}% ({lang === 'hi' ? 'सीमा से अधिक / Over Quota' : 'Over Quota'})
                        </span>
                      ) : (
                        <span>{monitoringData.stats.plan_usage_percentage}% {lang === 'hi' ? 'प्रयुक्त' : 'used'}</span>
                      )}
                      <span className={monitoringData.stats.total_shops > monitoringData.distributor.max_shops ? 'text-rose-600 font-black' : 'text-emerald-700 font-bold'}>
                        {monitoringData.stats.total_shops > monitoringData.distributor.max_shops
                          ? `+${monitoringData.stats.total_shops - monitoringData.distributor.max_shops} ${lang === 'hi' ? 'दुकानें अतिरिक्त' : 'over limit'}`
                          : `${monitoringData.distributor.max_shops - monitoringData.stats.total_shops} ${lang === 'hi' ? 'स्लॉट शेष' : 'slots left'}`}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 2. Total Shopkeeper Market Outstanding */}
                <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/90 shadow-xs flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                      {t.totalShopBalance}
                    </span>
                    <div className="p-2 rounded-2xl bg-rose-50 text-rose-700">
                      <Receipt className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="text-2xl font-black text-rose-900 tracking-tight">
                      {formatCurrency(monitoringData.stats.total_balance)}
                    </div>
                    <div className="text-[11px] text-slate-500 font-semibold mt-1">
                      {lang === 'hi'
                        ? 'इस वितरक के दुकानदारों पर कुल बकाया उधारी'
                        : 'Total unpaid ledger balance across retail shops'}
                    </div>
                  </div>
                </div>

                {/* 3. Today's Velocity */}
                <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/90 shadow-xs flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                      {t.todayOrders} & {lang === 'hi' ? 'बिक्री' : 'Turnover'}
                    </span>
                    <div className="p-2 rounded-2xl bg-sky-50 text-sky-700">
                      <PackageCheck className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="text-2xl font-black text-slate-900 tracking-tight">
                      {monitoringData.stats.today_orders_count}{' '}
                      <span className="text-xs text-slate-400 font-bold">{lang === 'hi' ? 'ऑर्डर' : 'orders'}</span>
                    </div>
                    <div className="text-[11px] text-emerald-800 font-black mt-1">
                      {formatCurrency(monitoringData.stats.today_sales_amount)}{' '}
                      <span className="text-slate-500 font-normal">
                        ({monitoringData.stats.active_shops_7d} {lang === 'hi' ? 'सक्रिय 7 दिन में' : 'active 7d'})
                      </span>
                    </div>
                  </div>
                </div>

                {/* 4. Subscription Health & Validity */}
                <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/90 shadow-xs flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                      {t.subscriptionStatus}
                    </span>
                    <div className="p-2 rounded-2xl bg-purple-50 text-purple-700">
                      <Clock className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="text-xl font-black text-slate-900 tracking-tight">
                      {formatCurrency(monitoringData.distributor.monthly_fee)}
                      <span className="text-xs text-slate-400 font-bold ml-1">/ mo</span>
                    </div>
                    <div className="text-[11px] text-slate-500 font-semibold mt-1">
                      {t.renewalDate}: <strong>{monitoringData.distributor.subscription_renewal_date}</strong>
                    </div>
                    <div className="text-[11px] mt-0.5 font-bold">
                      {getDaysRemainingText(monitoringData.distributor.subscription_renewal_date)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Real-Time Shopkeeper Network Table */}
              <div className="bg-white rounded-3xl border border-slate-200/90 shadow-xs overflow-hidden">
                <div className="p-5 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-50/50">
                  <div>
                    <h3 className="font-black text-slate-900 text-base flex items-center gap-2">
                      <Store className="w-4 h-4 text-emerald-700" />
                      <span>{t.allRegisteredShops}</span>
                      <span className="text-xs font-bold text-slate-400">
                        ({monitoringData.shops.length} / {monitoringData.distributor.max_shops})
                      </span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {lang === 'hi'
                        ? `"${monitoringData.distributor.business_name}" के अधीन संचालित सभी किराना / खुदरा दुकानें एवं उनका लेन-देन`
                        : `Live retail shops and daily ledger balances managed under ${monitoringData.distributor.business_name}`}
                    </p>
                  </div>

                  {/* Table search & route filter */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder={lang === 'hi' ? 'दुकान या मोबाइल खोजें...' : 'Search shop or mobile...'}
                        value={monitoringShopSearch}
                        onChange={(e) => setMonitoringShopSearch(e.target.value)}
                        className="pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs font-medium focus:outline-none focus:border-emerald-600 bg-white"
                      />
                    </div>

                    {/* Route Filter */}
                    {(() => {
                      const routes = Array.from(new Set(monitoringData.shops.map((s) => s.route).filter(Boolean)));
                      return (
                        <select
                          value={monitoringRouteFilter}
                          onChange={(e) => setMonitoringRouteFilter(e.target.value)}
                          className="px-2.5 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 bg-white"
                        >
                          <option value="all">{lang === 'hi' ? 'सभी रूट (All Routes)' : 'All Routes'}</option>
                          {routes.map((r, rIdx) => (
                            <option key={`mon-route-${r}-${rIdx}`} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      );
                    })()}
                  </div>
                </div>

                {/* Shops List Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500 font-black uppercase text-[10px] border-b border-slate-200">
                      <tr>
                        <th className="p-3.5">#</th>
                        <th className="p-3.5">{lang === 'hi' ? 'दुकान का नाम व कोड' : 'Shop Name & Code'}</th>
                        <th className="p-3.5">{lang === 'hi' ? 'संचालक व मोबाइल' : 'Owner & Phone'}</th>
                        <th className="p-3.5">{t.routeTerritory}</th>
                        <th className="p-3.5">{lang === 'hi' ? 'बाज़ार उधारी (Ledger Due)' : 'Ledger Balance'}</th>
                        <th className="p-3.5">{t.orderToday}</th>
                        <th className="p-3.5">{t.lastOrder}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium">
                      {monitoringData.shops
                        .filter((s) => {
                          const q = (monitoringShopSearch || '').toLowerCase().trim();
                          const matchQ =
                            !q ||
                            String(s.shop_name || '').toLowerCase().includes(q) ||
                            String(s.shop_code || '').toLowerCase().includes(q) ||
                            String(s.owner_name || '').toLowerCase().includes(q) ||
                            String(s.mobile || '').includes(q);
                          const matchRoute =
                            monitoringRouteFilter === 'all' || s.route === monitoringRouteFilter;
                          return matchQ && matchRoute;
                        })
                        .map((shop, sIdx) => (
                          <tr key={`sa-mon-shop-${shop.id ?? sIdx}-${sIdx}`} className="hover:bg-slate-50/70 transition">
                            <td className="p-3.5 text-slate-400 font-mono">{sIdx + 1}</td>
                            <td className="p-3.5">
                              <div className="font-black text-slate-900 text-sm">{shop.shop_name}</div>
                              <div className="font-mono text-[10px] text-slate-400">{shop.shop_code}</div>
                            </td>
                            <td className="p-3.5">
                              <div className="font-bold text-slate-800">{shop.owner_name}</div>
                              <div className="font-mono text-slate-500 text-[11px]">{shop.mobile}</div>
                            </td>
                            <td className="p-3.5">
                              <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-bold text-[11px] border border-slate-200">
                                {shop.route || 'मुख्य रूट'}
                              </span>
                              {shop.area && <div className="text-[10px] text-slate-400 mt-0.5">{shop.area}</div>}
                            </td>
                            <td className="p-3.5">
                              {shop.balance > 0 ? (
                                <span className="inline-flex items-center gap-1 font-black text-rose-700 bg-rose-50 px-2 py-0.5 rounded-lg border border-rose-200">
                                  {formatCurrency(shop.balance)}
                                </span>
                              ) : shop.balance < 0 ? (
                                <span className="inline-flex items-center gap-1 font-bold text-sky-700 bg-sky-50 px-2 py-0.5 rounded-lg border border-sky-200">
                                  +{formatCurrency(Math.abs(shop.balance))} (अग्रिम)
                                </span>
                              ) : (
                                <span className="text-slate-400 font-bold">₹0.00 (बेबाक)</span>
                              )}
                            </td>
                            <td className="p-3.5">
                              {shop.today_order_status && shop.today_order_status !== 'Not Ordered' ? (
                                <div className="space-y-0.5">
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-200">
                                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                    <span>{shop.today_order_status}</span>
                                  </span>
                                  {shop.today_order_amount && shop.today_order_amount > 0 ? (
                                    <div className="font-mono font-bold text-emerald-900 text-[11px]">
                                      {formatCurrency(shop.today_order_amount)}
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <span className="text-slate-400 text-[11px] font-medium">
                                  {lang === 'hi' ? 'आज ऑर्डर नहीं' : 'Not Ordered'}
                                </span>
                              )}
                            </td>
                            <td className="p-3.5 font-mono text-slate-500 text-[11px]">
                              {shop.last_order_date || '-'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                {monitoringData.shops.length === 0 && (
                  <div className="p-12 text-center text-slate-400">
                    <Store className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p className="font-bold text-sm">{t.noShopsFound}</p>
                    <p className="text-xs text-slate-400 mt-1">
                      {lang === 'hi'
                        ? 'इस वितरक के पोर्टल में जाकर नई दुकानें व दुकानदार जोड़े जा सकते हैं।'
                        : 'Log into distributor portal to onboard shopkeepers for this region.'}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white p-12 text-center rounded-3xl border border-slate-200 text-slate-400">
              <Activity className="w-12 h-12 mx-auto mb-3 opacity-30 text-emerald-700" />
              <p className="font-bold text-sm">
                {lang === 'hi' ? 'कृपया ऊपर सूची से कोई वितरक चुनें' : 'Please select a distributor from above to monitor'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 2: SUBSCRIPTION BILLING & PAYMENTS HISTORY */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'billing' && (
        <div className="bg-white rounded-3xl border border-slate-200/90 shadow-xs overflow-hidden">
          <div className="p-5 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 className="font-black text-slate-900 text-base flex items-center gap-2">
                <Receipt className="w-4 h-4 text-emerald-700" />
                <span>{t.subscriptionPaymentsHistory}</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'hi'
                  ? 'वितरकों से प्राप्त सभी मासिक सब्सक्रिप्शन शुल्कों का ब्योरा'
                  : 'Complete audit of monthly SaaS subscription payments collected from distributors'}
              </p>
            </div>
            <div className="font-extrabold text-xs text-emerald-800 bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-200">
              {payments.length} {lang === 'hi' ? 'भुगतान दर्ज' : 'payments recorded'}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 font-black uppercase text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3.5">#</th>
                  <th className="p-3.5">{t.distributorName}</th>
                  <th className="p-3.5">{t.plan}</th>
                  <th className="p-3.5">{t.date}</th>
                  <th className="p-3.5">{lang === 'hi' ? 'वैधता अवधि' : 'Validity Period'}</th>
                  <th className="p-3.5">{lang === 'hi' ? 'भुगतान माध्यम' : 'Payment Mode'}</th>
                  <th className="p-3.5">{lang === 'hi' ? 'संदर्भ / ट्रांजेक्शन' : 'Ref No'}</th>
                  <th className="p-3.5 text-right">{t.totalAmount}</th>
                  <th className="p-3.5 text-center">{lang === 'hi' ? 'स्थिति व कार्रवाई' : 'Status & Action'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {payments.map((p, idx) => (
                  <tr key={`sa-sub-pay-${p.id ?? idx}-${idx}`} className="hover:bg-slate-50/60 transition">
                    <td className="p-3.5 text-slate-400 font-mono">{idx + 1}</td>
                    <td className="p-3.5">
                      <div className="font-black text-slate-900">{p.business_name}</div>
                      <div className="text-[11px] text-slate-500">{p.owner_name} • {p.city}</div>
                    </td>
                    <td className="p-3.5">{getPlanBadge(p.plan_name || 'Growth Pro')}</td>
                    <td className="p-3.5 font-bold text-slate-700">{p.payment_date}</td>
                    <td className="p-3.5">
                      <span className="font-mono text-slate-600">
                        {p.period_start} → {p.period_end}
                      </span>
                    </td>
                    <td className="p-3.5">
                      <span className="px-2 py-0.5 rounded-md bg-slate-100 font-bold text-slate-700 text-[11px]">
                        {p.payment_mode}
                      </span>
                    </td>
                    <td className="p-3.5 font-mono text-slate-500 text-[11px]">
                      {p.reference_no || '-'}
                    </td>
                    <td className="p-3.5 text-right font-black text-sm text-emerald-800">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="p-3.5 text-center">
                      {p.status === 'pending' ? (
                        <div className="flex items-center justify-center gap-1.5 flex-wrap">
                          <span className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 font-bold text-[10px] animate-pulse">
                            {lang === 'hi' ? 'पुष्टि प्रतीक्षित' : 'Pending Settlement'}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleApproveSubPayment(p.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px] shadow-xs transition active:scale-95 cursor-pointer"
                            title="Approve"
                          >
                            ✓ {lang === 'hi' ? 'स्वीकार' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRejectSubPayment(p.id)}
                            disabled={actionLoading}
                            className="px-2 py-1 rounded-lg bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold text-[11px] transition active:scale-95 cursor-pointer"
                            title="Reject"
                          >
                            ✕ {lang === 'hi' ? 'खारिज' : 'Reject'}
                          </button>
                        </div>
                      ) : p.status === 'rejected' ? (
                        <span className="px-2 py-0.5 rounded-md bg-rose-100 text-rose-700 font-bold text-[10px]">
                          {lang === 'hi' ? 'अस्वीकृत' : 'Rejected'}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                          {lang === 'hi' ? 'सक्रिय / स्वीकृत' : 'Settled / Active'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* ------------------------------------------------------------- */}
      {/* TAB 3: SAAS TIERS & PRICING PLANS */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'plans' && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="font-black text-base text-slate-900 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-emerald-700" />
                <span>{lang === 'hi' ? 'वेदिरतसेतु B2B मासिक सब्सक्रिप्शन प्लान प्रबंधन' : 'VedirtSetu B2B Subscription Tiers Management'}</span>
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                {lang === 'hi'
                  ? 'मुख्य एडमिन के रूप में आप यहाँ से किसी भी प्लान का मासिक शुल्क (₹), वार्षिक शुल्क, अधिकतम दुकानों की सीमा और फीचर्स सीधे संपादित कर सकते हैं।'
                  : 'As Super Admin, you have full control to edit monthly fees (₹), yearly fees, maximum shop limits, and tier features.'}
              </p>
            </div>
            <button
              onClick={handleOpenAddPlan}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-md transition self-start sm:self-auto shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>{lang === 'hi' ? 'नया प्लान जोड़ें' : 'Add Custom Tier'}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(plans.length > 0 ? plans : [
              {
                id: 'starter',
                name: 'Starter Plan',
                name_hi: 'स्टार्टर प्लान',
                monthly_fee: 999,
                yearly_fee: 9990,
                max_shops: 30,
                description: 'छोटे एवं नए थोक वितरकों के लिए आदर्श',
                description_en: 'Ideal for small or emerging wholesale distributors',
                features_hi: ['30 दुकानों तक का नेटवर्क', 'दैनिक कटऑफ व रूट ऑर्डर समेकन', '1-क्लिक व्हाट्सएप ऑर्डर पर्ची', 'डिजिटल लेज़र व बेसिक बिलिंग'],
                features_en: ['Up to 30 Retailer Shops', 'Daily Morning & Evening Ordering', 'Consolidated Demand Summary', '1-Click WhatsApp Order Slips', 'Basic Ledger & Billing'],
                popular: false,
              },
              {
                id: 'growth',
                name: 'Growth Pro',
                name_hi: 'ग्रोथ प्रो',
                monthly_fee: 1999,
                yearly_fee: 19990,
                max_shops: 100,
                description: 'मध्यम व बड़े डेयरी डिस्ट्रीब्यूटर्स के लिए सर्वाधिक लोकप्रिय',
                description_en: 'Designed for high volume city milk distributors',
                features_hi: ['100 दुकानों तक का नेटवर्क', 'मल्टीपल डिलीवरी रूट (उत्तर, मध्य, दक्षिण)', 'UPI QR कोड से तुरंत बकाया वसूली', 'व्हाट्सएप ऑटोमैटिक रिमाइंडर', 'थर्मल प्रिंटर चालान व विस्तृत लेजर'],
                features_en: ['Up to 100 Retailer Shops', 'Multiple Delivery Routes', 'Instant UPI QR Code Payment Collection', 'Automated WhatsApp Reminders', 'Full Outstanding Ledger & Thermal Slip Printing'],
                popular: true,
              },
              {
                id: 'enterprise',
                name: 'Enterprise Hub',
                name_hi: 'एंटरप्राइज हब',
                monthly_fee: 3999,
                yearly_fee: 39990,
                max_shops: 500,
                description: 'जिले स्तर की बड़ी एजेंसियां व बहु-रूट नेटवर्क',
                description_en: 'District level distributors with 250+ outlets',
                features_hi: ['असीमित दुकानें (500+ तक)', 'कस्टम डिलीवरी व्हीकल रूट्स व ड्राइवर पर्चियां', 'समर्पित अकाउंट मैनेजर व 24x7 फोन सपोर्ट', 'एडवांस्ड सेल्स एनालिटिक्स व CSV रिपोर्ट्स'],
                features_en: ['Unlimited Retailer Shops (up to 500+)', 'Custom Vehicle Delivery Routes & Driver Slips', 'Dedicated Account Manager & 24x7 Phone Support', 'Advanced Sales Analytics & CSV Exports'],
                popular: false,
              }
            ]).map((plan, pIdx) => {
              const feats = lang === 'hi'
                ? (Array.isArray(plan.features_hi) && plan.features_hi.length > 0 ? plan.features_hi : (Array.isArray(plan.features_en) ? plan.features_en : []))
                : (Array.isArray(plan.features_en) && plan.features_en.length > 0 ? plan.features_en : (Array.isArray(plan.features_hi) ? plan.features_hi : []));
              const isPop = Boolean(plan.popular);

              return (
                <div
                  key={`sa-plan-${plan.id ?? pIdx}-${pIdx}`}
                  className={`p-6 rounded-3xl shadow-xs flex flex-col justify-between border relative overflow-hidden transition ${
                    isPop
                      ? 'bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 text-white border-2 border-emerald-500/60 shadow-xl'
                      : 'bg-white text-slate-900 border-slate-200'
                  }`}
                >
                  {isPop && (
                    <div className="absolute top-4 right-4 bg-emerald-500 text-slate-950 font-black text-[10px] px-2.5 py-0.5 rounded-full uppercase tracking-wider shadow-sm">
                      {lang === 'hi' ? 'सर्वाधिक लोकप्रिय' : 'Most Popular'}
                    </div>
                  )}

                  <div>
                    <div className={`inline-block px-3 py-1 rounded-full text-xs font-black mb-3 ${
                      isPop
                        ? 'bg-white/10 text-emerald-300 border border-white/20'
                        : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    }`}>
                      {lang === 'hi' ? (plan.name_hi || plan.name) : plan.name}
                    </div>

                    <div className="flex items-baseline gap-1.5">
                      <span className={`text-3xl font-black tracking-tight ${isPop ? 'text-white' : 'text-slate-900'}`}>
                        ₹{plan.monthly_fee?.toLocaleString('en-IN')}
                      </span>
                      <span className={`text-xs font-bold ${isPop ? 'text-emerald-300/70' : 'text-slate-400'}`}>
                        / {lang === 'hi' ? 'माह' : 'month'}
                      </span>
                    </div>

                    <div className={`text-[11px] font-semibold mt-1 ${isPop ? 'text-emerald-200/60' : 'text-slate-500'}`}>
                      वार्षिक: ₹{plan.yearly_fee?.toLocaleString('en-IN')} / वर्ष • अधिकतम {plan.max_shops} दुकानें
                    </div>

                    <p className={`text-xs mt-3 leading-relaxed ${isPop ? 'text-emerald-100/70' : 'text-slate-500'}`}>
                      {lang === 'hi' ? (plan.description || plan.description_en) : (plan.description_en || plan.description)}
                    </p>

                    <div className="mt-5 space-y-2 text-xs font-semibold">
                      {feats.map((f: string, idx: number) => (
                        <div key={`plan-feat-${plan.id ?? pIdx}-${idx}`} className="flex items-start gap-2">
                          <CheckCircle2 className={`w-4 h-4 shrink-0 mt-0.5 ${isPop ? 'text-emerald-400' : 'text-emerald-600'}`} />
                          <span className={isPop ? 'text-emerald-100' : 'text-slate-700'}>{f}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-6 pt-4 border-t border-slate-100/20">
                    <button
                      onClick={() => handleEditPlan(plan)}
                      className={`w-full py-2.5 px-4 rounded-xl font-black text-xs flex items-center justify-center gap-2 transition active:scale-98 ${
                        isPop
                          ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md shadow-emerald-500/20'
                          : 'bg-slate-900 hover:bg-slate-800 text-white shadow-xs'
                      }`}
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>{lang === 'hi' ? 'प्लान व कीमतें बदलें' : 'Edit Plan & Pricing'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 4: PLATFORM PAYMENT QR & UPI SETTINGS (SUPER ADMIN) */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'settings' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <div className="bg-white p-6 sm:p-7 rounded-3xl border border-slate-200 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0">
                  <QrCode className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-black text-base sm:text-lg text-slate-900">
                    {lang === 'hi' ? 'प्लेटफॉर्म सब्सक्रिप्शन पेमेंट QR व UPI सेटिंग्स' : 'Platform Subscription Payment QR & UPI'}
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {lang === 'hi'
                      ? 'यह QR कोड और UPI आईडी सभी वितरकों को सॉफ्टवेयर प्लान रिन्यूअल के समय दिखाई देगा।'
                      : 'This QR code and UPI ID will be shown to all distributors during SaaS plan renewal.'}
                  </p>
                </div>
              </div>

              {platformQrSavedMsg && (
                <div className="px-4 py-2 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs font-bold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>{platformQrSavedMsg}</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-6">
              {/* Form Controls (7 cols) */}
              <form onSubmit={handleSavePlatformQr} className="lg:col-span-7 space-y-4">
                <div>
                  <label className="block text-xs font-black text-slate-700 uppercase tracking-wider mb-1.5">
                    {lang === 'hi' ? 'प्लेटफॉर्म UPI आईडी (UPI ID):' : 'Platform UPI ID:'} *
                  </label>
                  <input
                    type="text"
                    value={platformUpi}
                    onChange={(e) => setPlatformUpi(e.target.value)}
                    required
                    placeholder="e.g. company@upi"
                    className="w-full px-4 py-3 rounded-2xl border border-slate-200 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20 font-mono text-sm font-bold text-slate-900 outline-none transition"
                  />
                  <span className="text-[11px] text-slate-400 block mt-1">
                    {lang === 'hi' ? 'वितरक इस UPI आईडी पर सीधा भुगतान कर सकेंगे' : 'Distributors can pay directly to this UPI ID'}
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-black text-slate-700 uppercase tracking-wider mb-1.5">
                    {lang === 'hi' ? 'प्लेटफॉर्म संचालक / प्राप्तकर्ता नाम:' : 'Payee / Platform Owner Name:'} *
                  </label>
                  <input
                    type="text"
                    value={platformOwner}
                    onChange={(e) => setPlatformOwner(e.target.value)}
                    required
                    placeholder="e.g. VedirtSetu Platforms"
                    className="w-full px-4 py-3 rounded-2xl border border-slate-200 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20 text-sm font-bold text-slate-900 outline-none transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-black text-slate-700 uppercase tracking-wider mb-1.5">
                    {lang === 'hi' ? 'पेमेंट क्यूआर कोड इमेज (Upload QR Code):' : 'Upload Payment QR Image:'}
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-xs transition">
                      <Upload className="w-4 h-4" />
                      <span>{lang === 'hi' ? 'नया QR कोड अपलोड करें' : 'Upload New QR Code'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handlePlatformQrUpload}
                        className="hidden"
                      />
                    </label>

                    {platformQrImage && (
                      <button
                        type="button"
                        onClick={() => setPlatformQrImage('')}
                        className="px-4 py-2.5 rounded-2xl border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold text-xs transition"
                      >
                        {lang === 'hi' ? 'कस्टम इमेज हटाएं (स्वतः QR का उपयोग करें)' : 'Remove Custom Image'}
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-2">
                    {lang === 'hi'
                      ? 'यदि आप अपनी बैंक/PhonePe/GPay का QR इमेज अपलोड नहीं करते हैं, तो सिस्टम स्वचालित रूप से आपकी UPI आईडी से डायनामिक QR कोड जनरेट कर देगा।'
                      : 'If no custom image is uploaded, the system will dynamically generate a clean QR code from your UPI ID.'}
                  </p>
                </div>

                <div className="pt-3">
                  <button
                    type="submit"
                    disabled={savingPlatformQr}
                    className="px-6 py-3.5 rounded-2xl bg-emerald-700 hover:bg-emerald-800 active:scale-98 text-white font-black text-sm shadow-md transition disabled:opacity-50 flex items-center gap-2"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{savingPlatformQr ? (lang === 'hi' ? 'सुरक्षित हो रहा है...' : 'Saving...') : (lang === 'hi' ? 'सेटिंग्स सुरक्षित करें' : 'Save Platform Settings')}</span>
                  </button>
                </div>
              </form>

              {/* Live Preview Card (5 cols) */}
              <div className="lg:col-span-5 bg-slate-50 p-5 rounded-3xl border border-slate-200 flex flex-col items-center justify-center text-center space-y-3">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                  {lang === 'hi' ? 'वितरक को ऐसा QR कोड दिखेगा (Live Preview)' : 'Distributor View Preview'}
                </span>

                <div className="p-3 bg-white rounded-2xl shadow-sm border border-slate-200">
                  <img
                    src={
                      platformQrImage ||
                      `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(
                        `upi://pay?pa=${encodeURIComponent(platformUpi)}&pn=${encodeURIComponent(
                          platformOwner
                        )}&cu=INR&tn=VedirtSetu Subscription`
                      )}`
                    }
                    alt="Platform QR Preview"
                    className="w-48 h-48 object-contain rounded-xl"
                  />
                </div>

                <div className="w-full bg-white p-3 rounded-2xl border border-slate-200 text-xs text-left">
                  <div className="font-bold text-slate-800 truncate">{platformOwner}</div>
                  <div className="font-mono text-emerald-700 font-bold text-[11px] truncate mt-0.5">{platformUpi}</div>
                </div>

                <span className="text-[11px] text-slate-400">
                  {platformQrImage
                    ? (lang === 'hi' ? '✓ आपका कस्टम QR कोड सक्रिय है' : '✓ Custom QR Image active')
                    : (lang === 'hi' ? '⚡ डायनामिक UPI QR सक्रिय है' : '⚡ Dynamic UPI QR active')}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: ADD / EDIT DISTRIBUTOR */}
      {/* ------------------------------------------------------------- */}
      {(showAddModal || editingDistributor) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base flex items-center gap-2">
                <Building2 className="w-5 h-5 text-amber-300" />
                <span>{editingDistributor ? t.editDistributor : t.addNewDistributor}</span>
              </div>
              <button
                onClick={() => {
                  setShowAddModal(false);
                  setEditingDistributor(null);
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

                  const business_name = (form.business_name.value || '').trim();
                  const owner_name = (form.owner_name.value || '').trim();
                  const mobile = (form.mobile.value || '').trim().replace(/\D/g, '');
                  const email = (form.email.value || '').trim();
                  const city = (form.city.value || '').trim();
                  const address = (form.address.value || '').trim();
                  const plan_name = (form.plan_name.value || '').trim();
                  const monthly_fee = Number(form.monthly_fee.value);
                  const subscription_status = form.subscription_status.value;
                  const subscription_renewal_date = (form.subscription_renewal_date.value || '').trim();
                  const max_shops = Number(form.max_shops.value);
                  const pin = (form.pin?.value || '').trim();

                  // STRICT VALIDATION: Koi bhi section khali nahi rahega
                  if (!business_name) {
                    setModalError(lang === 'hi' ? 'कृपया वितरक/डेयरी का नाम भरें।' : 'Please enter distributor business name.');
                    return;
                  }
                  if (!owner_name) {
                    setModalError(lang === 'hi' ? 'कृपया वितरक मालिक का नाम भरें।' : 'Please enter owner name.');
                    return;
                  }
                  if (!mobile || mobile.length < 10) {
                    setModalError(lang === 'hi' ? 'कृपया वैध 10-अंकीय मोबाइल नंबर दर्ज करें।' : 'Please enter a valid 10-digit mobile number.');
                    return;
                  }
                  if (!city) {
                    setModalError(lang === 'hi' ? 'कृपया शहर / क्षेत्र (City) भरें।' : 'Please enter city / territory.');
                    return;
                  }
                  if (!plan_name) {
                    setModalError(lang === 'hi' ? 'कृपया सब्सक्रिप्शन प्लान चुनें।' : 'Please select subscription plan.');
                    return;
                  }
                  if (!monthly_fee || monthly_fee <= 0 || isNaN(monthly_fee)) {
                    setModalError(lang === 'hi' ? 'कृपया वैध मासिक शुल्क दर्ज करें।' : 'Please enter valid monthly fee.');
                    return;
                  }
                  if (!max_shops || max_shops <= 0 || isNaN(max_shops)) {
                    setModalError(lang === 'hi' ? 'कृपया अधिकतम दुकानों की सीमा (Max Shops) दर्ज करें।' : 'Please enter max shops limit.');
                    return;
                  }
                  if (!subscription_renewal_date) {
                    setModalError(lang === 'hi' ? 'कृपया रिन्यूअल तारीख दर्ज करें।' : 'Please enter renewal date.');
                    return;
                  }
                  if (!pin || pin.length < 4) {
                    setModalError(lang === 'hi' ? 'सुरक्षा पिन कम से कम 4 अंकों का होना आवश्यक है।' : 'Security PIN must be at least 4 digits.');
                    return;
                  }

                  setActionLoading(true);

                  const data = {
                    business_name,
                    owner_name,
                    mobile,
                    email: email || `${mobile}@wholesale.com`,
                    city,
                    address,
                    plan_name,
                    monthly_fee,
                    subscription_status,
                    subscription_renewal_date,
                    max_shops,
                    pin,
                  };

                  try {
                    let savedDistId: string | number | undefined = editingDistributor?.id;
                    if (editingDistributor) {
                      await api.updateDistributor(editingDistributor.id, data);
                      setSuccessToast(t.distributorSavedSuccess);
                    } else {
                      const createdRes = await api.createDistributor(data);
                      savedDistId = createdRes?.id;
                      setSuccessToast(t.distributorSavedSuccess);
                    }
                    const cleanMob = String(mobile || '').replace(/\D/g, '');
                    const mob10 = cleanMob.slice(-10);
                    if (cleanMob) sessionDeletedDists.current.delete(cleanMob);
                    if (mob10) sessionDeletedDists.current.delete(mob10);
                    if (savedDistId !== undefined && savedDistId !== null) {
                      sessionDeletedDists.current.delete(String(savedDistId));
                    }
                    try {
                      const stored = localStorage.getItem('vedirt_deleted_distributors');
                      if (stored) {
                        const filtered = (JSON.parse(stored) as string[]).filter(
                          (x) => x !== cleanMob && x !== mob10 && String(x) !== String(savedDistId || '')
                        );
                        localStorage.setItem('vedirt_deleted_distributors', JSON.stringify(filtered));
                      }
                    } catch (e) {}
                    setShowAddModal(false);
                    setEditingDistributor(null);
                    await loadData();
                  } catch (err: any) {
                    setModalError(err.message || 'त्रुटि उत्पन्न हुई');
                  } finally {
                    setActionLoading(false);
                  }
                }}
                className="space-y-3"
              >
                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.distributorName} *</label>
                  <input
                    type="text"
                    name="business_name"
                    defaultValue={editingDistributor?.business_name}
                    placeholder="उदा. श्री श्याम ट्रेडर्स व डिस्ट्रीब्यूटर्स (Shree Shyam Distributors)"
                    required
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-bold"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{t.distributorOwner} *</label>
                    <input
                      type="text"
                      name="owner_name"
                      defaultValue={editingDistributor?.owner_name}
                      placeholder="उदा. राजेश कुमार"
                      required
                      className="w-full p-2.5 rounded-xl border border-slate-300"
                    />
                  </div>
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{t.phone} (Login ID) *</label>
                    <input
                      type="text"
                      name="mobile"
                      defaultValue={editingDistributor?.mobile}
                      placeholder="9876543210"
                      required
                      className="w-full p-2.5 rounded-xl border border-slate-300 font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{t.cityTerritory} *</label>
                    <input
                      type="text"
                      name="city"
                      defaultValue={editingDistributor?.city}
                      placeholder="उदा. जयपुर (उत्तर ज़ोन)"
                      required
                      className="w-full p-2.5 rounded-xl border border-slate-300"
                    />
                  </div>
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{lang === 'hi' ? 'ईमेल' : 'Email'}</label>
                    <input
                      type="email"
                      name="email"
                      defaultValue={editingDistributor?.email}
                      placeholder="distributor@wholesale.com"
                      className="w-full p-2.5 rounded-xl border border-slate-300"
                    />
                  </div>
                </div>

                {/* Subscription Plan & Monthly Fee */}
                <div className="grid grid-cols-2 gap-2 p-3 bg-emerald-50/70 rounded-2xl border border-emerald-200">
                  <div>
                    <label className="block font-bold text-emerald-950 mb-1">{t.plan}</label>
                    <select
                      name="plan_name"
                      defaultValue={editingDistributor?.plan_name || plans[1]?.name || plans[0]?.name || 'Growth Pro'}
                      className="w-full p-2 rounded-xl border border-emerald-300 font-bold bg-white"
                      onChange={(e) => {
                        const feeInput = (document.getElementsByName('monthly_fee')[0] as HTMLInputElement);
                        const shopInput = (document.getElementsByName('max_shops')[0] as HTMLInputElement);
                        const selected = plans.find((p) => p.name === e.target.value || p.id === e.target.value);
                        if (selected) {
                          if (feeInput) feeInput.value = String(selected.monthly_fee);
                          if (shopInput) shopInput.value = String(selected.max_shops);
                        }
                      }}
                    >
                      {plans.map((p) => (
                        <option key={p.id} value={p.name}>
                          {lang === 'hi' && p.name_hi ? p.name_hi : p.name} ({formatCurrency(p.monthly_fee)}/माह - {p.max_shops} दुकानें)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block font-bold text-emerald-950 mb-1">{t.monthlyFee}</label>
                    <input
                      type="number"
                      name="monthly_fee"
                      defaultValue={editingDistributor?.monthly_fee || 1999}
                      required
                      className="w-full p-2 rounded-xl border border-emerald-300 font-bold bg-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{t.subscriptionStatus}</label>
                    <select
                      name="subscription_status"
                      defaultValue={editingDistributor?.subscription_status || 'active'}
                      className="w-full p-2 rounded-xl border border-slate-300 font-bold"
                    >
                      <option value="active">{getSubscriptionStatusName('active', lang)}</option>
                      <option value="trial">{getSubscriptionStatusName('trial', lang)}</option>
                      <option value="expired">{getSubscriptionStatusName('expired', lang)}</option>
                      <option value="suspended">{getSubscriptionStatusName('suspended', lang)}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{t.renewalDate}</label>
                    <input
                      type="date"
                      name="subscription_renewal_date"
                      defaultValue={
                        editingDistributor?.subscription_renewal_date ||
                        new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
                      }
                      required
                      className="w-full p-2 rounded-xl border border-slate-300 font-bold"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{t.maxShops}</label>
                    <input
                      type="number"
                      name="max_shops"
                      defaultValue={editingDistributor?.max_shops || 100}
                      required
                      className="w-full p-2 rounded-xl border border-slate-300 font-bold"
                    />
                  </div>
                </div>

                <div className="p-3 bg-emerald-50/70 rounded-2xl border border-emerald-200">
                  <label className="block font-bold text-emerald-950 mb-1 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-emerald-700" />
                    <span>{lang === 'hi' ? 'वितरक सुरक्षा पिन (Security PIN):' : 'Distributor Security PIN:'} *</span>
                  </label>
                  <input
                    type="text"
                    name="pin"
                    defaultValue={editingDistributor?.login_pin || '1234'}
                    maxLength={8}
                    required
                    placeholder="1234"
                    className="w-full p-2 rounded-xl border border-emerald-300 font-mono font-bold tracking-widest text-emerald-950 bg-white"
                  />
                  <p className="text-[10px] text-emerald-800 mt-1 font-medium">
                    {lang === 'hi'
                      ? 'वितरक अपने मोबाइल नंबर और इसी 4-अंकीय पिन से ऐप में लॉगिन करेगा'
                      : 'The distributor will login using their mobile number and this PIN'}
                  </p>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.address}</label>
                  <textarea
                    name="address"
                    rows={2}
                    defaultValue={editingDistributor?.address}
                    placeholder="गोदाम / वितरण केंद्र का पता"
                    className="w-full p-2.5 rounded-xl border border-slate-300"
                  />
                </div>

                <button
                  type="submit"
                  disabled={actionLoading}
                  className="w-full py-3 rounded-2xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm shadow-md transition disabled:opacity-50"
                >
                  {actionLoading ? t.loading : t.save}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: RESET DISTRIBUTOR PIN */}
      {/* ------------------------------------------------------------- */}
      {resetPinDistributor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-sm flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-300" />
                <span>{lang === 'hi' ? 'वितरक सुरक्षा पिन रीसेट करें' : 'Reset Distributor PIN'}</span>
              </div>
              <button
                onClick={() => setResetPinDistributor(null)}
                className="text-white hover:text-emerald-200"
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const cleanPin = (distPinInput || '').trim();
                if (!cleanPin || cleanPin.length < 4) {
                  setErrorToast(lang === 'hi' ? 'कृपया कम से कम 4-अंकीय पिन दर्ज करें।' : 'Please enter at least a 4-digit PIN.');
                  return;
                }
                setIsUpdatingDistPin(true);
                try {
                  await api.resetDistributorPin(resetPinDistributor.id, cleanPin);
                  setSuccessToast(lang === 'hi' ? 'वितरक का पिन सफलतापूर्वक बदल दिया गया!' : 'Distributor PIN updated successfully!');
                  setResetPinDistributor(null);
                  await loadData();
                } catch (err: any) {
                  setErrorToast(err.message || (lang === 'hi' ? 'पिन बदलने में त्रुटि' : 'Error updating PIN'));
                } finally {
                  setIsUpdatingDistPin(false);
                }
              }}
              className="p-5 space-y-4 text-xs"
            >
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl">
                <div className="font-black text-sm text-slate-900">{resetPinDistributor.business_name}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {resetPinDistributor.owner_name} • <span className="font-mono">{resetPinDistributor.mobile}</span>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  {lang === 'hi' ? 'नया 4 या 6-अंकीय सुरक्षा पिन:' : 'New 4 or 6-digit Security PIN:'} *
                </label>
                <input
                  type="text"
                  value={distPinInput}
                  onChange={(e) => setDistPinInput(e.target.value)}
                  maxLength={8}
                  required
                  placeholder="1234"
                  className="w-full p-3 rounded-2xl border border-slate-300 font-mono font-black text-center text-xl tracking-widest text-emerald-950 focus:border-emerald-600 outline-hidden bg-slate-50"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  {lang === 'hi' ? 'वितरक इस नए पिन से ऐप में लॉगिन करेगा।' : 'The distributor will login with this new PIN.'}
                </p>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setResetPinDistributor(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 font-bold text-slate-700 hover:bg-slate-100 transition"
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  disabled={isUpdatingDistPin || distPinInput.trim().length < 4}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold transition shadow-xs disabled:opacity-50"
                >
                  {isUpdatingDistPin ? (lang === 'hi' ? 'सेव हो रहा है...' : 'Saving...') : (lang === 'hi' ? 'पिन सेव करें' : 'Save PIN')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: RECORD SUBSCRIPTION PAYMENT */}
      {/* ------------------------------------------------------------- */}
      {paymentDistributor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base flex items-center gap-2">
                <Receipt className="w-5 h-5 text-amber-300" />
                <span>{t.recordSubscriptionPayment}</span>
              </div>
              <button
                onClick={() => setPaymentDistributor(null)}
                className="text-white hover:text-emerald-200"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              {modalError && (
                <div className="p-3 rounded-xl bg-red-50 text-red-700 text-xs font-bold border border-red-200">
                  {modalError}
                </div>
              )}

              <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-2xl space-y-1">
                <div className="font-black text-sm text-emerald-950">
                  {paymentDistributor.business_name}
                </div>
                <div className="text-slate-600">
                  <span className="font-bold">{paymentDistributor.owner_name}</span> • {paymentDistributor.city}
                </div>
                <div className="text-slate-600">
                  {t.plan}: <strong>{paymentDistributor.plan_name}</strong> (नियमित दर: {formatCurrency(paymentDistributor.monthly_fee)}/माह)
                </div>
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setModalError('');
                  const form = e.currentTarget;

                  const amount = Number(form.amount.value);
                  const payment_date = (form.payment_date.value || '').trim();
                  const period_start = (form.period_start.value || '').trim();
                  const period_end = (form.period_end.value || '').trim();
                  const payment_mode = (form.payment_mode.value || '').trim();
                  const reference_no = (form.reference_no.value || '').trim();
                  const notes = (form.notes.value || '').trim();

                  if (!amount || amount <= 0 || isNaN(amount)) {
                    setModalError(lang === 'hi' ? 'कृपया वैध भुगतान राशि (Amount) दर्ज करें।' : 'Please enter valid amount.');
                    return;
                  }
                  if (!payment_date) {
                    setModalError(lang === 'hi' ? 'कृपया भुगतान की तारीख चुनें।' : 'Please select payment date.');
                    return;
                  }
                  if (!period_start || !period_end) {
                    setModalError(lang === 'hi' ? 'कृपया अवधि की शुरुआत व समाप्ति तारीख भरें।' : 'Please fill valid period dates.');
                    return;
                  }

                  setActionLoading(true);

                  const data = {
                    amount,
                    payment_date,
                    period_start,
                    period_end,
                    payment_mode: payment_mode || 'UPI',
                    reference_no,
                    notes,
                  };

                  try {
                    await api.recordDistributorPayment(paymentDistributor.id, data);
                    setPaymentDistributor(null);
                    setSuccessToast(t.subscriptionPaymentSuccess);
                    await loadData();
                  } catch (err: any) {
                    setModalError(err.message || 'भुगतान दर्ज करने में त्रुटि');
                  } finally {
                    setActionLoading(false);
                  }
                }}
                className="space-y-3"
              >
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{t.totalAmount} (₹) *</label>
                    <input
                      type="number"
                      name="amount"
                      defaultValue={paymentDistributor.monthly_fee}
                      required
                      className="w-full p-2.5 rounded-xl border border-slate-300 font-black text-sm text-emerald-900"
                    />
                  </div>
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{lang === 'hi' ? 'भुगतान दिनांक' : 'Payment Date'} *</label>
                    <input
                      type="date"
                      name="payment_date"
                      defaultValue={new Date().toISOString().split('T')[0]}
                      required
                      className="w-full p-2.5 rounded-xl border border-slate-300"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{lang === 'hi' ? 'वैधता प्रारंभ' : 'Period Start'}</label>
                    <input
                      type="date"
                      name="period_start"
                      defaultValue={paymentDistributor.subscription_renewal_date || new Date().toISOString().split('T')[0]}
                      required
                      className="w-full p-2 rounded-xl border border-slate-300 font-bold"
                    />
                  </div>
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{lang === 'hi' ? 'नया नवीनीकरण (Period End)' : 'Next Renewal'}</label>
                    <input
                      type="date"
                      name="period_end"
                      defaultValue={new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]}
                      required
                      className="w-full p-2 rounded-xl border border-slate-300 font-bold text-emerald-800"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{lang === 'hi' ? 'भुगतान माध्यम' : 'Payment Mode'}</label>
                    <select name="payment_mode" defaultValue="UPI" className="w-full p-2.5 rounded-xl border border-slate-300 font-bold">
                      <option value="UPI">UPI (PhonePe/GPay)</option>
                      <option value="Bank Transfer">Bank Transfer (NEFT/IMPS)</option>
                      <option value="Cash">Cash (नकद)</option>
                      <option value="Cheque">Cheque</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">{lang === 'hi' ? 'ट्रांजेक्शन / UTR' : 'Ref / UTR No'}</label>
                    <input
                      type="text"
                      name="reference_no"
                      placeholder="उदा. UPI-2837482"
                      className="w-full p-2.5 rounded-xl border border-slate-300 font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">{t.notes}</label>
                  <input
                    type="text"
                    name="notes"
                    placeholder="उदा. अक्टूबर महीने का अग्रिम शुल्क"
                    className="w-full p-2.5 rounded-xl border border-slate-300"
                  />
                </div>

                <button
                  type="submit"
                  disabled={actionLoading}
                  className="w-full py-3 rounded-2xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm shadow-md transition disabled:opacity-50"
                >
                  {actionLoading ? t.loading : t.renewSubscription}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: CONFIRM DELETE DISTRIBUTOR */}
      {/* ------------------------------------------------------------- */}
      {distributorToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-rose-700 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-bold text-base flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-300" />
                <span>{t.confirmDeleteDistributor}</span>
              </div>
              <button
                onClick={() => setDistributorToDelete(null)}
                className="text-white hover:text-rose-200"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl space-y-1">
                <div className="font-black text-sm text-rose-950">
                  {distributorToDelete.business_name}
                </div>
                <div className="text-slate-600">
                  {distributorToDelete.owner_name} • {distributorToDelete.mobile} • {distributorToDelete.city}
                </div>
                <div className="text-rose-800 font-bold text-[11px] mt-1 pt-1 border-t border-rose-200">
                  {lang === 'hi'
                    ? `इस वितरक का खाता बंद कर दिया जाएगा, लेकिन उनके द्वारा जोड़ी गई ${distributorToDelete.shops_count || 0} दुकानों और पिछले सभी ऑर्डर्स का ऐतिहासिक रिकॉर्ड सुरक्षित रहेगा।`
                    : `This distributor account will be deactivated, but historical records for ${distributorToDelete.shops_count || 0} shops and past orders will remain safely preserved.`}
                </div>
              </div>

              <p className="text-slate-600 leading-relaxed">
                {t.confirmDeleteDistributorDesc}
              </p>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDistributorToDelete(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 font-bold text-slate-700 hover:bg-slate-100 transition"
                >
                  {t.cancel}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      setActionLoading(true);
                      const targetId = distributorToDelete.id;
                      const targetMobile = distributorToDelete.mobile;
                      const targetFirestoreId = (distributorToDelete as any).firestore_id;

                      // 0. Track permanently in deleted set and localStorage so no cloud snapshot or reload can resurrect it
                      const cleanTargMob = String(targetMobile || '').replace(/\D/g, '');
                      if (targetId) sessionDeletedDists.current.add(String(targetId));
                      if (cleanTargMob) sessionDeletedDists.current.add(cleanTargMob);
                      if (targetFirestoreId) sessionDeletedDists.current.add(String(targetFirestoreId));

                      try {
                        if (cleanTargMob === '9876543210' || String(targetId) === '1') {
                          localStorage.setItem('vedirt_demo_deleted', '1');
                        }
                        const stored = localStorage.getItem('vedirt_deleted_distributors');
                        const existingArr = stored ? (JSON.parse(stored) as string[]).filter((x) => String(x).length >= 10 || isNaN(Number(x))) : [];
                        const set = new Set<string>(existingArr);
                        if (cleanTargMob.length >= 10) set.add(cleanTargMob);
                        if (cleanTargMob.length >= 10) set.add(cleanTargMob.slice(-10));
                        if (targetFirestoreId && (String(targetFirestoreId).length >= 10 || isNaN(Number(targetFirestoreId)))) set.add(String(targetFirestoreId));
                        localStorage.setItem('vedirt_deleted_distributors', JSON.stringify(Array.from(set)));
                      } catch (e) {}

                      // 1. UI से तुरंत हटाएं (ID, Mobile और Firestore ID तीनों से)
                      setDistributors((prev) =>
                        prev.filter((d) => {
                          const dMob = String(d.mobile || '').replace(/\D/g, '');
                          const tMob = String(targetMobile || '').replace(/\D/g, '');
                          const matchMob = tMob && dMob === tMob;
                          const matchId = targetId && String(d.id) === String(targetId);
                          const matchFId = targetFirestoreId && (d as any).firestore_id === targetFirestoreId;
                          return !matchMob && !matchId && !matchFId;
                        })
                      );

                      // 2. Firebase और सर्वर पर सॉफ्ट-डिलीट करें
                      await api.deleteDistributor(targetId, targetMobile, targetFirestoreId);

                      // 3. Update top metrics
                      setMetrics((prev) => prev ? {
                        ...prev,
                        total_distributors: Math.max(0, (prev.total_distributors || 1) - 1),
                        active_distributors: distributorToDelete.subscription_status === 'active' ? Math.max(0, (prev.active_distributors || 1) - 1) : prev.active_distributors,
                        trial_distributors: distributorToDelete.subscription_status === 'trial' ? Math.max(0, (prev.trial_distributors || 1) - 1) : prev.trial_distributors,
                        expired_distributors: (distributorToDelete.subscription_status === 'expired' || distributorToDelete.subscription_status === 'suspended') ? Math.max(0, (prev.expired_distributors || 1) - 1) : prev.expired_distributors,
                        total_mrr: distributorToDelete.subscription_status === 'active' ? Math.max(0, (prev.total_mrr || 0) - (distributorToDelete.monthly_fee || 0)) : prev.total_mrr,
                      } : prev);

                      setDistributorToDelete(null);
                      setSuccessToast(t.distributorDeletedSuccess);
                      await loadData();
                    } catch (err: any) {
                      setErrorToast(err.message || 'वितरक हटाने में विफल');
                    } finally {
                      setActionLoading(false);
                    }
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold transition flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>{actionLoading ? t.loading : t.confirmDeleteDistributorBtn}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* ------------------------------------------------------------- */}
      {/* MODAL: VIEW DISTRIBUTOR REGISTERED SHOPS DIRECTLY */}
      {/* ------------------------------------------------------------- */}
      {shopViewDistributor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/75 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-4xl bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95">
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-emerald-950 via-emerald-900 to-slate-900 text-white p-5 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center">
                  <Store className="w-5 h-5 text-emerald-300" />
                </div>
                <div>
                  <h3 className="font-black text-base sm:text-lg tracking-tight">
                    {shopViewDistributor.business_name} {lang === 'hi' ? 'की पंजीकृत दुकानें' : '— Registered Shops'}
                  </h3>
                  <p className="text-xs text-emerald-200/80 font-medium">
                    {shopViewDistributor.owner_name} • {shopViewDistributor.city} • <span className="font-mono">{shopViewDistributor.mobile}</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShopViewDistributor(null)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition cursor-pointer font-bold"
              >
                ✕
              </button>
            </div>

            {/* Filter and Stats Bar */}
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={shopViewSearch}
                    onChange={(e) => setShopViewSearch(e.target.value)}
                    placeholder={lang === 'hi' ? 'दुकान का नाम, कोड, मालिक या मोबाइल से खोजें...' : 'Search shop, code, owner or mobile...'}
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <select
                  value={shopViewRoute}
                  onChange={(e) => setShopViewRoute(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="all">{lang === 'hi' ? 'सभी रूट (All Routes)' : 'All Routes'}</option>
                  {Array.from(new Set(shopViewList.map((s) => s.route).filter(Boolean))).map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
                <span className="px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-900">
                  {lang === 'hi' ? 'कुल दुकानें:' : 'Total:'} <strong>{shopViewList.length}</strong>
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-slate-200 text-slate-800">
                  {lang === 'hi' ? 'कुल बकाया:' : 'Balance:'} <strong>{formatCurrency(shopViewList.reduce((sum, s) => sum + (s.balance || s.outstanding_balance || 0), 0))}</strong>
                </span>
              </div>
            </div>

            {/* Modal Body / Table */}
            <div className="flex-1 overflow-y-auto p-4">
              {shopViewLoading ? (
                <div className="py-12 text-center text-slate-400">
                  <div className="w-8 h-8 border-3 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-xs font-bold">{lang === 'hi' ? 'दुकानें लोड हो रही हैं...' : 'Loading shops...'}</p>
                </div>
              ) : shopViewList.length === 0 ? (
                <div className="py-12 text-center text-slate-400">
                  <Store className="w-12 h-12 mx-auto mb-2 opacity-30 text-slate-500" />
                  <p className="text-sm font-bold text-slate-600">
                    {lang === 'hi' ? 'इस वितरक के पास अभी कोई पंजीकृत दुकान नहीं है' : 'No registered shops found for this distributor'}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 text-slate-600 font-black uppercase text-[10px] tracking-wider">
                      <tr>
                        <th className="p-3">#</th>
                        <th className="p-3">{lang === 'hi' ? 'दुकान व कोड' : 'Shop & Code'}</th>
                        <th className="p-3">{lang === 'hi' ? 'दुकानदार व संपर्क' : 'Owner & Contact'}</th>
                        <th className="p-3">{lang === 'hi' ? 'रूट व क्षेत्र' : 'Route & Area'}</th>
                        <th className="p-3">{lang === 'hi' ? 'आज का ऑर्डर' : 'Today Order'}</th>
                        <th className="p-3 text-right">{lang === 'hi' ? 'बकाया (Balance)' : 'Balance'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium">
                      {shopViewList
                        .filter((s) => {
                          const q = shopViewSearch.toLowerCase().trim();
                          const matchSearch =
                            !q ||
                            String(s.shop_name || '').toLowerCase().includes(q) ||
                            String(s.shop_code || '').toLowerCase().includes(q) ||
                            String(s.owner_name || '').toLowerCase().includes(q) ||
                            String(s.mobile || '').includes(q);
                          const matchRoute = shopViewRoute === 'all' || s.route === shopViewRoute;
                          return matchSearch && matchRoute;
                        })
                        .map((s, sIdx) => (
                          <tr key={`shop-row-${s.id}-${sIdx}`} className="hover:bg-slate-50/80 transition">
                            <td className="p-3 font-mono text-slate-400">{sIdx + 1}</td>
                            <td className="p-3">
                              <div className="font-black text-slate-900">{s.shop_name}</div>
                              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-bold">
                                {s.shop_code}
                              </span>
                            </td>
                            <td className="p-3">
                              <div className="font-bold text-slate-800">{s.owner_name}</div>
                              <a
                                href={`tel:${s.mobile}`}
                                className="font-mono text-[11px] text-emerald-700 hover:underline"
                              >
                                {s.mobile}
                              </a>
                            </td>
                            <td className="p-3">
                              <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-bold text-[10px]">
                                {s.route || (lang === 'hi' ? 'सामान्य रूट' : 'Default Route')}
                              </span>
                              {s.area && (
                                <div className="text-[10px] text-slate-400 mt-0.5">{s.area}</div>
                              )}
                            </td>
                            <td className="p-3">
                              {s.today_order_status && s.today_order_status !== 'Not Ordered' ? (
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                  s.today_order_status === 'Delivered'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-amber-100 text-amber-800'
                                }`}>
                                  ✓ {s.today_order_status} {s.today_order_amount ? `(${formatCurrency(s.today_order_amount)})` : ''}
                                </span>
                              ) : (
                                <span className="text-slate-400 text-[11px]">
                                  {lang === 'hi' ? 'ऑर्डर नहीं आया' : 'No order'}
                                </span>
                              )}
                            </td>
                            <td className="p-3 text-right">
                              <span className={`font-black ${
                                (s.balance || s.outstanding_balance || 0) > 0 ? 'text-rose-600' : 'text-emerald-700'
                              }`}>
                                {formatCurrency(s.balance || s.outstanding_balance || 0)}
                              </span>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end shrink-0">
              <button
                type="button"
                onClick={() => setShopViewDistributor(null)}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition active:scale-95"
              >
                {t.close}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODAL: EDIT / ADD SUBSCRIPTION PLAN */}
      {/* ------------------------------------------------------------- */}
      {(editingPlan || showAddPlanModal) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95">
            <div className="bg-emerald-900 text-white px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-emerald-300" />
                <span className="font-extrabold text-sm sm:text-base">
                  {showAddPlanModal
                    ? (lang === 'hi' ? 'नया सब्सक्रिप्शन प्लान बनाएं' : 'Create New Subscription Tier')
                    : (lang === 'hi' ? `प्लान संपादित करें: ${editingPlan.name}` : `Edit Tier: ${editingPlan.name}`)}
                </span>
              </div>
              <button
                onClick={() => {
                  setEditingPlan(null);
                  setShowAddPlanModal(false);
                }}
                className="text-white/70 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSavePlan} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'प्लान नाम (English)' : 'Tier Name (English)'} *
                  </label>
                  <input
                    type="text"
                    required
                    value={planForm.name}
                    onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'प्लान नाम (हिंदी)' : 'Tier Name (Hindi)'}
                  </label>
                  <input
                    type="text"
                    value={planForm.name_hi}
                    onChange={(e) => setPlanForm({ ...planForm, name_hi: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'मासिक शुल्क (₹)' : 'Monthly Fee (₹)'} *
                  </label>
                  <input
                    type="number"
                    min="0"
                    required
                    value={planForm.monthly_fee}
                    onChange={(e) => setPlanForm({ ...planForm, monthly_fee: Number(e.target.value) })}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-bold text-emerald-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'वार्षिक शुल्क (₹)' : 'Yearly Fee (₹)'} *
                  </label>
                  <input
                    type="number"
                    min="0"
                    required
                    value={planForm.yearly_fee}
                    onChange={(e) => setPlanForm({ ...planForm, yearly_fee: Number(e.target.value) })}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-bold text-emerald-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'दुकान सीमा' : 'Max Shops'} *
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={planForm.max_shops}
                    onChange={(e) => setPlanForm({ ...planForm, max_shops: Number(e.target.value) })}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'विवरण (हिंदी / Primary)' : 'Description (Hindi / Primary)'}
                  </label>
                  <textarea
                    rows={2}
                    value={planForm.description}
                    onChange={(e) => setPlanForm({ ...planForm, description: e.target.value })}
                    placeholder="उदा. मध्यम व बड़े थोक डिस्ट्रीब्यूटर्स के लिए"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'विवरण (English)' : 'Description (English)'}
                  </label>
                  <textarea
                    rows={2}
                    value={planForm.description_en}
                    onChange={(e) => setPlanForm({ ...planForm, description_en: e.target.value })}
                    placeholder="e.g. Ideal for growing wholesale distributors"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'फीचर्स (हिंदी - प्रत्येक लाइन में एक)' : 'Features (Hindi - One per line)'}
                  </label>
                  <textarea
                    rows={4}
                    value={planForm.features_hi}
                    onChange={(e) => setPlanForm({ ...planForm, features_hi: e.target.value })}
                    placeholder={"100 दुकानों तक का नेटवर्क\nमल्टीपल डिलीवरी रूट\nUPI QR वसूली\nव्हाट्सएप रिमाइंडर"}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {lang === 'hi' ? 'फीचर्स (English - प्रत्येक लाइन में एक)' : 'Features (English - One per line)'}
                  </label>
                  <textarea
                    rows={4}
                    value={planForm.features_en}
                    onChange={(e) => setPlanForm({ ...planForm, features_en: e.target.value })}
                    placeholder={"Up to 100 Retailer Shops\nMultiple Delivery Routes\nInstant UPI QR Collection\nWhatsApp Reminders"}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 p-3 rounded-2xl border border-slate-200 bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={planForm.popular}
                  onChange={(e) => setPlanForm({ ...planForm, popular: e.target.checked })}
                  className="w-4 h-4 rounded text-emerald-700 focus:ring-emerald-500"
                />
                <span className="text-xs font-bold text-slate-800">
                  {lang === 'hi' ? 'सर्वाधिक लोकप्रिय (Most Popular) बैज दिखाएं' : 'Show "Most Popular" highlight badge'}
                </span>
              </label>

              <div className="flex gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setEditingPlan(null);
                    setShowAddPlanModal(false);
                  }}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition"
                >
                  {t.cancel}
                </button>
                <button
                  type="submit"
                  disabled={savingPlan}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-md disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{savingPlan ? t.loading : (lang === 'hi' ? 'प्लान सुरक्षित करें' : 'Save Plan Changes')}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default SuperAdminDashboard;
