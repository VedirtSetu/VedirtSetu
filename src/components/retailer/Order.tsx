import React, { useState, useEffect, useMemo } from 'react';
import { Product, Order as OrderType, SystemSettings } from '../../types/index.ts';
import {
  Language,
  translations,
  formatCurrency,
  getCategoryName,
  getUnitName,
  getProductName,
} from '../../utils/i18n.ts';
import { api } from '../../services/api.ts';
import { evaluateCutoff } from '../../utils/cutoff.ts';
import {
  Plus,
  Minus,
  ShoppingBag,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  X,
  Clock,
  Sparkles,
  Trash2,
  ShoppingCart,
  Check,
} from 'lucide-react';

export interface OrderProps {
  lang: Language;
  existingOrder?: OrderType | null;
  settings?: SystemSettings | null;
  onSuccess: (orderId: number) => void;
  onCancel?: () => void;
}

interface DraftItem {
  product: Product;
  quantity: number;
}

export const Order: React.FC<OrderProps> = ({
  lang,
  existingOrder,
  settings,
  onSuccess,
  onCancel,
}) => {
  const t = translations[lang];

  // Products list from backend
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [loadingProducts, setLoadingProducts] = useState(true);

  // Stepper staging quantities per product id: productId -> quantity
  const [stagingQuantities, setStagingQuantities] = useState<Record<number, number>>({});

  // Client-side order draft state: productId -> DraftItem
  const [orderDraft, setOrderDraft] = useState<Record<number, DraftItem>>({});

  // Order notes & options
  const [notes, setNotes] = useState(existingOrder?.notes || '');
  const [saveAsRegular, setSaveAsRegular] = useState(false);

  // UI modals & feedback states
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');
  const [justAddedId, setJustAddedId] = useState<number | null>(null);

  // Load products & initialize draft if editing existing order
  useEffect(() => {
    let isMounted = true;
    setLoadingProducts(true);

    api.getProducts()
      .then((prods) => {
        if (!isMounted) return;
        setProducts(prods);

        const initialDraft: Record<number, DraftItem> = {};
        const initialStaging: Record<number, number> = {};

        prods.forEach((p) => {
          initialStaging[p.id] = 0;
        });

        if (existingOrder && existingOrder.items) {
          existingOrder.items.forEach((it) => {
            const prod = prods.find((p) => p.id === it.product_id);
            if (prod) {
              initialDraft[prod.id] = { product: prod, quantity: it.ordered_quantity };
              initialStaging[prod.id] = it.ordered_quantity;
            }
          });
        }

        setOrderDraft(initialDraft);
        setStagingQuantities(initialStaging);
      })
      .catch((err) => {
        if (!isMounted) return;
        setErrorMsg(err.message || (lang === 'hi' ? 'उत्पाद लोड नहीं हो सके' : 'Failed to load products'));
      })
      .finally(() => {
        if (isMounted) setLoadingProducts(false);
      });

    return () => {
      isMounted = false;
    };
  }, [existingOrder, lang]);

  // Live timer tick so cutoff status & countdown auto-update while page stays open
  const [cutoffTick, setCutoffTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setCutoffTick((prev) => prev + 1);
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Cutoff time inspection using unified cycle engine
  const cutoffInfo = useMemo(() => {
    const rawCutoff = settings?.cutoff_time || '20:00';
    const allowLate = settings?.allow_late_orders ?? true;

    const evalResult = evaluateCutoff(rawCutoff);
    const timeRemainingStr = lang === 'hi' ? evalResult.timeRemainingStrHi : evalResult.timeRemainingStrEn;

    return {
      cutoffTime: evalResult.cutoffTime,
      isPastCutoff: evalResult.isPastCutoff,
      allowLate,
      timeRemainingStr,
      canSubmit: !evalResult.isPastCutoff || allowLate,
    };
  }, [settings, lang, cutoffTick]);

  // Categories list
  const categories = useMemo(() => {
    return ['All', ...Array.from(new Set(products.map((p) => p.category)))];
  }, [products]);

  // Filtered products list
  const filteredProducts = useMemo(() => {
    if (selectedCategory === 'All') return products;
    return products.filter((p) => p.category === selectedCategory);
  }, [products, selectedCategory]);

  // Draft calculations
  const draftList = useMemo(() => Object.values(orderDraft), [orderDraft]);
  const totalItemCount = useMemo(
    () => draftList.reduce((sum, item) => sum + item.quantity, 0),
    [draftList]
  );
  const totalAmount = useMemo(
    () => draftList.reduce((sum, item) => sum + item.product.price * item.quantity, 0),
    [draftList]
  );

  const hasSubMoqItems = useMemo(
    () => draftList.some((it) => it.quantity < (it.product.minimum_quantity && it.product.minimum_quantity > 1 ? it.product.minimum_quantity : 1)),
    [draftList]
  );

  // Quantity Stepper handlers (+/-) with MOQ awareness & unified auto-sync with order draft
  const handleStepQuantity = (productId: number, delta: number) => {
    const prod = products.find((p) => p.id === productId);
    if (!prod || !prod.stock_available) return;
    const minQty = prod.minimum_quantity && prod.minimum_quantity > 1 ? prod.minimum_quantity : 1;

    setStagingQuantities((prev) => {
      const current = prev[productId] !== undefined ? prev[productId] : 0;
      let next = current + delta;
      if (current === 0 && delta > 0) {
        next = Math.max(minQty, delta);
      } else if (next > 0 && next < minQty && delta < 0) {
        next = 0;
      } else {
        next = Math.max(0, next);
      }

      setOrderDraft((draftPrev) => {
        if (next <= 0) {
          if (!draftPrev[productId]) return draftPrev;
          const copy = { ...draftPrev };
          delete copy[productId];
          return copy;
        }
        return {
          ...draftPrev,
          [productId]: { product: prod, quantity: next },
        };
      });

      return { ...prev, [productId]: next };
    });
  };

  // Handle direct keyboard input in quantity input box
  const handleDirectQuantityChange = (productId: number, valStr: string) => {
    const prod = products.find((p) => p.id === productId);
    if (!prod || !prod.stock_available) return;
    const minQty = prod.minimum_quantity && prod.minimum_quantity > 1 ? prod.minimum_quantity : 1;

    // Allow user to clear input while typing (empty string)
    if (valStr === '') {
      setStagingQuantities((prev) => ({
        ...prev,
        [productId]: 0,
      }));
      return;
    }

    const val = parseInt(valStr, 10);
    const cleanVal = isNaN(val) ? 0 : Math.max(0, val);

    setStagingQuantities((prev) => ({
      ...prev,
      [productId]: cleanVal,
    }));

    // If cleanVal meets or exceeds MOQ, automatically sync into draft!
    // Never allow direct keyboard typing to bypass MOQ in the cart draft.
    if (cleanVal >= minQty) {
      setOrderDraft((draftPrev) => ({
        ...draftPrev,
        [productId]: { product: prod, quantity: cleanVal },
      }));
    }
  };

  // On blur: definitive validation of direct keyboard input with automatic MOQ clamping and draft sync
  const handleQuantityBlur = (productId: number) => {
    const prod = products.find((p) => p.id === productId);
    if (!prod) return;
    const minQty = prod.minimum_quantity && prod.minimum_quantity > 1 ? prod.minimum_quantity : 1;
    const entered = stagingQuantities[productId] !== undefined ? stagingQuantities[productId] : 0;

    if (entered <= 0) {
      // User entered 0 or cleared: reset staging to 0 and remove from cart if present
      setStagingQuantities((prev) => ({ ...prev, [productId]: 0 }));
      setOrderDraft((prev) => {
        if (!prev[productId]) return prev;
        const copy = { ...prev };
        delete copy[productId];
        return copy;
      });
      return;
    }

    if (entered < minQty) {
      // Entered value is below MOQ: automatically clamp to minQty and sync to draft
      setStagingQuantities((prev) => ({ ...prev, [productId]: minQty }));
      setOrderDraft((prev) => ({
        ...prev,
        [productId]: { product: prod, quantity: minQty },
      }));
      setErrorMsg(
        lang === 'hi'
          ? `'${getProductName(prod, lang)}' के लिए न्यूनतम ऑर्डर मात्रा (MOQ) कम से कम ${minQty} ${getUnitName(prod.unit, lang)} है। मात्रा स्वतः ${minQty} निर्धारित की गई।`
          : `Minimum order quantity (MOQ) for '${getProductName(prod, lang)}' is ${minQty} ${getUnitName(prod.unit, lang)}. Adjusted to ${minQty}.`
      );
      setTimeout(() => setErrorMsg(''), 4000);
      return;
    }

    // Entered value satisfies MOQ: sync to both staging and draft
    setStagingQuantities((prev) => ({ ...prev, [productId]: entered }));
    setOrderDraft((prev) => ({
      ...prev,
      [productId]: { product: prod, quantity: entered },
    }));
  };

  // Add to Order handler with strict MOQ enforcement
  const handleAddToOrder = (product: Product) => {
    if (!product.stock_available) {
      setErrorMsg(
        lang === 'hi'
          ? `'${getProductName(product, lang)}' अभी आउट ऑफ स्टॉक (Out of Stock) है`
          : `'${getProductName(product, lang)}' is currently out of stock`
      );
      setTimeout(() => setErrorMsg(''), 4000);
      return;
    }

    const minQty = product.minimum_quantity && product.minimum_quantity > 1 ? product.minimum_quantity : 1;
    const rawQty = stagingQuantities[product.id] !== undefined ? stagingQuantities[product.id] : 0;
    const qty = rawQty === 0 ? minQty : rawQty;

    if (qty < minQty) {
      setStagingQuantities((prev) => ({ ...prev, [product.id]: minQty }));
      setOrderDraft((prev) => ({
        ...prev,
        [product.id]: {
          product,
          quantity: minQty,
        },
      }));
      setErrorMsg(
        lang === 'hi'
          ? `'${getProductName(product, lang)}' के लिए न्यूनतम ऑर्डर मात्रा (MOQ) ${minQty} ${getUnitName(product.unit, lang)} है। मात्रा स्वतः ${minQty} सेट की गई।`
          : `Minimum order quantity (MOQ) for '${getProductName(product, lang)}' is ${minQty} ${getUnitName(product.unit, lang)}. Set to ${minQty}.`
      );
      setTimeout(() => setErrorMsg(''), 4000);
      setJustAddedId(product.id);
      setTimeout(() => setJustAddedId(null), 1200);
      return;
    }

    setStagingQuantities((prev) => ({ ...prev, [product.id]: qty }));
    setOrderDraft((prev) => ({
      ...prev,
      [product.id]: {
        product,
        quantity: qty,
      },
    }));

    // Trigger visual feedback
    setJustAddedId(product.id);
    setTimeout(() => setJustAddedId(null), 1200);
  };

  // Remove item from draft and reset staging quantity to 0
  const handleRemoveFromOrder = (productId: number) => {
    setOrderDraft((prev) => {
      const copy = { ...prev };
      delete copy[productId];
      return copy;
    });
    setStagingQuantities((prev) => ({
      ...prev,
      [productId]: 0,
    }));
  };

  // Clear entire draft and all staging quantities
  const confirmClearDraft = () => {
    setOrderDraft({});
    setStagingQuantities({});
    setShowClearConfirmModal(false);
  };

  // Load regular saved defaults
  const handleLoadRegularDefaults = async () => {
    try {
      const defaults = await api.getRegularDefaults();
      if (defaults && defaults.length > 0) {
        const newDraft: Record<number, DraftItem> = {};
        const newStaging: Record<number, number> = {};

        defaults.forEach((d: any) => {
          const prod = products.find((p) => p.id === d.product_id);
          if (prod) {
            newDraft[prod.id] = { product: prod, quantity: d.quantity };
            newStaging[prod.id] = d.quantity;
          }
        });

        setOrderDraft(newDraft);
        setStagingQuantities(newStaging);
        setInfoMsg(
          lang === 'hi'
            ? 'नियमित डिफ़ॉल्ट मात्रा सफलतापूर्वक लोड हो गई।'
            : 'Regular default quantities loaded successfully.'
        );
        setTimeout(() => setInfoMsg(''), 4000);
      } else {
        setErrorMsg(t.noRegularSaved);
        setTimeout(() => setErrorMsg(''), 4000);
      }
    } catch (err: any) {
      setErrorMsg(err.message || t.error);
    }
  };

  // Final Order Submission
  const handleSubmitOrder = async () => {
    // Reconcile any staged quantity >= minQty into orderDraft to prevent silent loss
    // in case user submitted before input blur completed
    const currentDraft = { ...orderDraft };
    let syncedAny = false;
    for (const [prodIdStr, stagingQty] of Object.entries(stagingQuantities)) {
      const pid = parseInt(prodIdStr, 10);
      if (stagingQty > 0) {
        const prod = products.find((p) => p.id === pid);
        if (prod && prod.stock_available) {
          const minQty = prod.minimum_quantity && prod.minimum_quantity > 1 ? prod.minimum_quantity : 1;
          const finalQty = Math.max(minQty, stagingQty);
          if (!currentDraft[pid] || currentDraft[pid].quantity !== finalQty) {
            currentDraft[pid] = { product: prod, quantity: finalQty };
            syncedAny = true;
          }
        }
      }
    }
    if (syncedAny) {
      setOrderDraft(currentDraft);
    }

    const currentDraftList = Object.values(currentDraft);
    if (currentDraftList.length === 0) {
      setErrorMsg(
        lang === 'hi'
          ? 'कृपया कम से कम एक उत्पाद को ऑर्डर में जोड़ें'
          : 'Please add at least one product to the order'
      );
      return;
    }

    if (!cutoffInfo.canSubmit) {
      setErrorMsg(
        lang === 'hi'
          ? `आज का ऑर्डर समय समाप्त हो चुका है (कटऑफ समय: ${cutoffInfo.cutoffTime})`
          : `Order cutoff time has passed (${cutoffInfo.cutoffTime}). New orders are closed for today.`
      );
      return;
    }

    // Validate that all items in the draft strictly satisfy their Minimum Order Quantity (MOQ)
    for (const item of currentDraftList) {
      const minQty = item.product.minimum_quantity && item.product.minimum_quantity > 1 ? item.product.minimum_quantity : 1;
      if (item.quantity < minQty) {
        setErrorMsg(
          lang === 'hi'
            ? `'${getProductName(item.product, lang)}' के लिए न्यूनतम ऑर्डर मात्रा (MOQ) कम से कम ${minQty} ${getUnitName(item.product.unit, lang)} है`
            : `Minimum order quantity (MOQ) for '${getProductName(item.product, lang)}' is ${minQty} ${getUnitName(item.product.unit, lang)}`
        );
        setOrderDraft((prev) => ({
          ...prev,
          [item.product.id]: { ...item, quantity: minQty },
        }));
        setStagingQuantities((prev) => ({
          ...prev,
          [item.product.id]: minQty,
        }));
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMsg('');

    try {
      const payloadItems = currentDraftList.map((item) => ({
        product_id: item.product.id,
        quantity: item.quantity,
      }));

      if (existingOrder) {
        // Update existing order
        await api.updateOrder(existingOrder.id, {
          items: payloadItems,
          notes,
          reason: lang === 'hi' ? 'दुकानदार द्वारा ऑर्डर सामग्री अद्यतन' : 'Updated by retailer',
        });
        onSuccess(existingOrder.id);
      } else {
        // Create new order
        const res = await api.createOrder({
          items: payloadItems,
          notes,
        });

        if (saveAsRegular) {
          try {
            await api.saveRegularOrder(0, payloadItems);
          } catch {
            // non-blocking
          }
        }

        onSuccess(res.id);
      }
    } catch (err: any) {
      setErrorMsg(err.message || (lang === 'hi' ? 'ऑर्डर दर्ज करने में विफल' : 'Failed to submit order'));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 pb-36 animate-in fade-in duration-200">
      {/* Top Header Card */}
      <div className="bg-white p-4 sm:p-5 rounded-3xl border border-emerald-100 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-black text-slate-900 flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-emerald-700" />
            <span>{existingOrder ? t.editOrder : t.newOrder}</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.orderCatalogSub}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!existingOrder && (
            <button
              type="button"
              onClick={handleLoadRegularDefaults}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-xs font-bold hover:bg-emerald-100 transition shadow-2xs"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span>{t.loadDefaultQty}</span>
            </button>
          )}

          {draftList.length > 0 && (
            <button
              type="button"
              onClick={() => setShowClearConfirmModal(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-red-200 bg-red-50 text-red-700 text-xs font-bold hover:bg-red-100 transition"
              title={t.clearDraft}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t.clearDraft}</span>
            </button>
          )}

          {onCancel && (
            <button
              onClick={onCancel}
              className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              title={t.close}
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Cutoff Notice Banner */}
      <div
        className={`p-3.5 rounded-2xl border flex items-center gap-3 text-xs shadow-2xs ${
          cutoffInfo.isPastCutoff
            ? cutoffInfo.allowLate
              ? 'bg-amber-50/90 border-amber-300 text-amber-950'
              : 'bg-red-50 border-red-300 text-red-950'
            : 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
        }`}
      >
        <Clock
          className={`w-5 h-5 shrink-0 ${
            cutoffInfo.isPastCutoff
              ? cutoffInfo.allowLate
                ? 'text-amber-600'
                : 'text-red-600'
              : 'text-emerald-700'
          }`}
        />
        <div className="flex-1">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="font-black text-xs sm:text-sm">
              {t.cutoffNotice}: {cutoffInfo.cutoffTime}
            </span>
            {cutoffInfo.timeRemainingStr && !cutoffInfo.isPastCutoff && (
              <span className="font-extrabold text-[11px] bg-emerald-200/80 text-emerald-900 px-2 py-0.5 rounded-md">
                {cutoffInfo.timeRemainingStr}
              </span>
            )}
          </div>
          <p className="text-[11px] mt-0.5 opacity-90">
            {cutoffInfo.isPastCutoff
              ? cutoffInfo.allowLate
                ? lang === 'hi'
                  ? 'कटऑफ समय समाप्त हो चुका है। आपका ऑर्डर विलंबित (Late Order) के रूप में भेजा जाएगा।'
                  : 'Daily cutoff time has passed. This order will be submitted as a Late Order.'
                : lang === 'hi'
                ? 'आज का ऑर्डर समय समाप्त हो चुका है। अब नए ऑर्डर स्वीकार नहीं किए जा रहे हैं।'
                : 'Order cutoff time has passed. New orders are closed for today.'
              : t.orderCutoffReminder}
          </p>
        </div>
      </div>

      {/* Info / Toast Alert */}
      {infoMsg && (
        <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-300 text-xs font-bold text-emerald-900 flex items-center gap-2 shadow-2xs animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{infoMsg}</span>
        </div>
      )}

      {/* Error Alert */}
      {errorMsg && (
        <div className="p-3.5 rounded-2xl bg-red-50 border border-red-200 text-xs font-bold text-red-700 flex items-center gap-2 shadow-2xs animate-in fade-in">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Category Filter Pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
        {categories.map((cat, catIdx) => (
          <button
            key={`order-cat-${cat}-${catIdx}`}
            onClick={() => setSelectedCategory(cat)}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition ${
              selectedCategory === cat
                ? 'bg-emerald-800 text-white shadow-2xs'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-emerald-50'
            }`}
          >
            {getCategoryName(cat, lang)}
          </button>
        ))}
      </div>

      {/* Product List */}
      {loadingProducts ? (
        <div className="py-12 text-center text-xs font-bold text-slate-400">
          {t.loading}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {filteredProducts.map((prod, pIdx) => {
            const inDraft = orderDraft[prod.id];
            const isAdded = !!inDraft && inDraft.quantity > 0;
            const currentQty =
              stagingQuantities[prod.id] !== undefined
                ? stagingQuantities[prod.id]
                : (inDraft ? inDraft.quantity : 0);
            const unitLabel = getUnitName(prod.unit, lang);
            const isJustAdded = justAddedId === prod.id;

            return (
              <div
                key={`order-prod-${prod.id ?? pIdx}-${pIdx}`}
                className={`p-4 rounded-3xl border transition bg-white shadow-xs flex flex-col justify-between ${
                  isAdded
                    ? 'border-emerald-600 ring-2 ring-emerald-500/20 bg-emerald-50/10'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                {/* Product Meta */}
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-black text-sm sm:text-base text-slate-900 leading-snug">
                        {getProductName(prod, lang)}
                      </h3>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <span className="text-xs font-black text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-lg">
                          {formatCurrency(prod.price)} / {unitLabel}
                        </span>
                        {prod.minimum_quantity && prod.minimum_quantity > 1 ? (
                          <span className="text-[10px] text-amber-900 bg-amber-50 border border-amber-300 px-2 py-0.5 rounded-md font-extrabold flex items-center gap-1 shadow-2xs">
                            <span>{lang === 'hi' ? `न्यूनतम (MOQ): ${prod.minimum_quantity}` : `MOQ: ${prod.minimum_quantity}`} {unitLabel}</span>
                          </span>
                        ) : null}
                        {prod.stock_available ? (
                          <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md font-bold">
                            {t.inStock}
                          </span>
                        ) : (
                          <span className="text-[10px] text-red-600 bg-red-50 px-2 py-0.5 rounded-md font-bold">
                            {t.outOfStock}
                          </span>
                        )}
                      </div>
                    </div>

                    {isAdded && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-black text-emerald-800 bg-emerald-100 border border-emerald-200 px-2 py-0.5 rounded-full shrink-0">
                        <Check className="w-3 h-3" />
                        <span>{t.inOrder} ({inDraft.quantity} {unitLabel})</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Bottom Row: Quantity Stepper (+/-) & Add to Order Button */}
                <div className="mt-4 pt-3 border-t border-slate-100 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-600">{t.quantity}:</span>

                    {/* Quantity Stepper (+/-) */}
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleStepQuantity(prod.id, -1)}
                        disabled={currentQty <= 0 || !prod.stock_available}
                        className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 active:scale-90 text-slate-700 flex items-center justify-center font-black text-base transition disabled:opacity-30 disabled:pointer-events-none"
                        aria-label="Decrease quantity"
                      >
                        <Minus className="w-4 h-4" />
                      </button>

                      <input
                        type="number"
                        min={0}
                        step={1}
                        disabled={!prod.stock_available}
                        value={currentQty === 0 ? '' : currentQty}
                        placeholder="0"
                        onKeyDown={(e) => {
                          if (e.key === '-' || e.key === 'e' || e.key === 'E') {
                            e.preventDefault();
                          }
                        }}
                        onChange={(e) => handleDirectQuantityChange(prod.id, e.target.value)}
                        onBlur={() => handleQuantityBlur(prod.id)}
                        className="w-14 h-10 text-center font-black text-sm text-slate-800 rounded-xl border border-slate-300 focus:border-emerald-600 focus:ring-1 focus:ring-emerald-200 outline-hidden disabled:opacity-40"
                      />

                      <button
                        type="button"
                        onClick={() => handleStepQuantity(prod.id, 1)}
                        disabled={!prod.stock_available}
                        className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 active:scale-90 text-slate-700 flex items-center justify-center font-black text-base transition disabled:opacity-30 disabled:pointer-events-none"
                        aria-label="Increase quantity"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Add to Order Button */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!prod.stock_available}
                      onClick={() => handleAddToOrder(prod)}
                      className={`flex-1 py-2.5 px-3 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 transition active:scale-98 disabled:opacity-40 disabled:pointer-events-none ${
                        isJustAdded
                          ? 'bg-emerald-600 text-white shadow-xs'
                          : isAdded
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-300 hover:bg-emerald-100'
                          : 'bg-emerald-700 hover:bg-emerald-800 text-white shadow-xs'
                      }`}
                    >
                      {isJustAdded ? (
                        <>
                          <Check className="w-4 h-4" />
                          <span>{t.addedToOrder}</span>
                        </>
                      ) : isAdded ? (
                        <>
                          <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                          <span>
                            {t.updateInOrder} ({currentQty} {unitLabel})
                          </span>
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" />
                          <span>{t.addToOrder}</span>
                        </>
                      )}
                    </button>

                    {isAdded && (
                      <button
                        type="button"
                        onClick={() => handleRemoveFromOrder(prod.id)}
                        className="p-2.5 rounded-xl border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                        title={t.remove}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Sticky Bottom Order Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200 p-3 sm:p-4 shadow-xl">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowDraftModal(true)}
              className="relative p-2.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 hover:bg-emerald-100 transition"
              title={t.viewDraft}
            >
              <ShoppingCart className="w-5 h-5 text-emerald-800" />
              {draftList.length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-emerald-700 text-white text-[10px] font-black flex items-center justify-center shadow-xs">
                  {draftList.length}
                </span>
              )}
            </button>

            <div>
              <div className="text-[11px] text-slate-500 font-bold">
                {totalItemCount} {t.itemsSelected} ({draftList.length} {t.items})
              </div>
              <div className="text-lg sm:text-2xl font-black text-emerald-900 leading-none">
                {formatCurrency(totalAmount)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="px-3.5 py-3 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs sm:text-sm hover:bg-slate-50 transition"
              >
                {t.close}
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowDraftModal(true)}
              disabled={draftList.length === 0}
              className="px-5 sm:px-8 py-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 active:scale-95 text-white font-black text-xs sm:text-sm shadow-md transition flex items-center gap-2 disabled:opacity-40 disabled:pointer-events-none"
            >
              <span>{t.reviewOrder}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Confirmation Modal: Clear Order Draft */}
      {showClearConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl border border-slate-200 text-center space-y-4 animate-in fade-in zoom-in-95">
            <div className="w-12 h-12 rounded-2xl bg-red-100 text-red-600 flex items-center justify-center mx-auto">
              <Trash2 className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-extrabold text-slate-900 text-base">
                {t.confirmClearDraftTitle}
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                {t.confirmClearDraftDesc}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowClearConfirmModal(false)}
                className="py-2.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                {t.confirmNo}
              </button>
              <button
                type="button"
                onClick={confirmClearDraft}
                className="py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-xs"
              >
                {t.confirmYes}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order Draft & Submission Modal */}
      {showDraftModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="bg-emerald-800 text-white px-5 py-4 flex items-center justify-between">
              <div className="font-extrabold text-base flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-amber-300" />
                <span>{t.reviewOrder}</span>
              </div>
              <button
                onClick={() => setShowDraftModal(false)}
                className="text-white/80 hover:text-white"
                title={t.close}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Draft Items List */}
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-2xl overflow-hidden bg-slate-50/50">
                {draftList.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-400 font-bold">
                    {t.noProductsInDraft}
                  </div>
                ) : (
                  draftList.map((it, dIdx) => {
                    const minQty = it.product.minimum_quantity && it.product.minimum_quantity > 1 ? it.product.minimum_quantity : 1;
                    const isSubMoq = it.quantity < minQty;
                    const currentStaging = stagingQuantities[it.product.id] !== undefined ? stagingQuantities[it.product.id] : it.quantity;

                    return (
                      <div
                        key={`draft-it-${it.product?.id ?? dIdx}-${dIdx}`}
                        className={`p-3 flex flex-wrap items-center justify-between text-xs gap-2 transition ${
                          isSubMoq ? 'bg-amber-50/80 border-l-4 border-l-amber-500' : ''
                        }`}
                      >
                        <div>
                          <div className="font-bold text-slate-900 flex flex-wrap items-center gap-1.5">
                            <span>{getProductName(it.product, lang)}</span>
                            {minQty > 1 && (
                              <span className="text-[10px] text-amber-900 bg-amber-100 border border-amber-300 px-1.5 py-0.5 rounded font-extrabold">
                                {lang === 'hi' ? `न्यूनतम (MOQ): ${minQty}` : `MOQ: ${minQty}`}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {formatCurrency(it.product.price)} / {getUnitName(it.product.unit, lang)}
                            {isSubMoq && (
                              <span className="text-amber-800 font-bold ml-2">
                                ⚠️ {lang === 'hi' ? `न्यूनतम ${minQty} आवश्यक है` : `Min ${minQty} required`}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {/* Cart Quantity Stepper with MOQ Safety */}
                          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1 shadow-2xs">
                            <button
                              type="button"
                              onClick={() => handleStepQuantity(it.product.id, -1)}
                              className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center font-black transition active:scale-90"
                              title="Decrease"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={currentStaging === 0 ? '' : currentStaging}
                              placeholder="0"
                              onKeyDown={(e) => {
                                if (e.key === '-' || e.key === 'e' || e.key === 'E') {
                                  e.preventDefault();
                                }
                              }}
                              onChange={(e) => handleDirectQuantityChange(it.product.id, e.target.value)}
                              onBlur={() => handleQuantityBlur(it.product.id)}
                              className="w-11 text-center font-black text-xs text-slate-800 outline-hidden"
                            />
                            <button
                              type="button"
                              onClick={() => handleStepQuantity(it.product.id, 1)}
                              className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center font-black transition active:scale-90"
                              title="Increase"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>

                          <div className="font-black text-slate-900 text-sm min-w-[55px] text-right">
                            {formatCurrency(it.product.price * it.quantity)}
                          </div>

                          <button
                            type="button"
                            onClick={() => handleRemoveFromOrder(it.product.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                            title={t.remove}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Total Summary */}
              <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-between">
                <span className="font-bold text-xs text-emerald-950">{t.totalAmount}:</span>
                <span className="font-black text-xl text-emerald-900">{formatCurrency(totalAmount)}</span>
              </div>

              {/* Delivery Notes */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">{t.notes}</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t.notesPlaceholder}
                  className="w-full p-3 rounded-xl border border-slate-300 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 text-xs font-medium outline-hidden"
                />
              </div>

              {/* Save as Regular Checkbox */}
              {!existingOrder && (
                <label className="flex items-center gap-2 p-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 cursor-pointer transition">
                  <input
                    type="checkbox"
                    checked={saveAsRegular}
                    onChange={(e) => setSaveAsRegular(e.target.checked)}
                    className="w-4 h-4 rounded text-emerald-700 focus:ring-emerald-500"
                  />
                  <span className="text-xs font-bold text-slate-700">{t.saveAsRegular}</span>
                </label>
              )}

              {/* Cutoff Warning within Modal */}
              {cutoffInfo.isPastCutoff && (
                <div
                  className={`p-3 rounded-xl text-xs font-bold border ${
                    cutoffInfo.allowLate
                      ? 'bg-amber-50 border-amber-200 text-amber-800'
                      : 'bg-red-50 border-red-200 text-red-800'
                  }`}
                >
                  {cutoffInfo.allowLate
                    ? lang === 'hi'
                      ? 'यह ऑर्डर कटऑफ समय के बाद दर्ज हो रहा है और विलंबित (Late Order) के रूप में भेजा जाएगा।'
                      : 'This order is submitted after cutoff time and will be marked as a Late Order.'
                    : lang === 'hi'
                    ? 'कटऑफ समय समाप्त हो चुका है। नया ऑर्डर जमा नहीं किया जा सकता।'
                    : 'Order window has closed for today.'}
                </div>
              )}

              {/* Sub-MOQ Warning Banner */}
              {hasSubMoqItems && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-xs font-bold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                  <span>
                    {lang === 'hi'
                      ? 'कुछ उत्पादों की मात्रा न्यूनतम आवश्यकता (MOQ) से कम है। कृपया आगे बढ़ने से पहले मात्रा बढ़ाएं।'
                      : 'Some products are below their Minimum Order Quantity (MOQ). Please increase quantity before submitting.'}
                  </span>
                </div>
              )}

              {errorMsg && (
                <div className="p-3 rounded-xl bg-red-50 text-red-700 text-xs font-bold">
                  {errorMsg}
                </div>
              )}

              {/* Submit Button */}
              <button
                type="button"
                onClick={handleSubmitOrder}
                disabled={isSubmitting || draftList.length === 0 || !cutoffInfo.canSubmit || hasSubMoqItems}
                className="w-full py-3.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 active:scale-[0.99] text-white font-black text-sm shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
              >
                {isSubmitting ? (
                  <span>{t.loading}</span>
                ) : (
                  <>
                    <span>{existingOrder ? t.editOrder : t.submitDailyOrder}</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Order;