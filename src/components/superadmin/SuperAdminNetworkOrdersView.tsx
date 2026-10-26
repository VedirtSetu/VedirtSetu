import React, { useState, useEffect } from 'react';
import { SuperAdminNetworkOrdersResponse, DistributorNetworkData, DistributorNetworkShopOrder } from '../../types/index.ts';
import { Language, formatCurrency, getProductName } from '../../utils/i18n.ts';
import { api } from '../../services/api.ts';
import {
  Calendar,
  Building2,
  Store,
  Package,
  Layers,
  Search,
  RefreshCw,
  Phone,
  Truck,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronUp,
  Filter,
  FileSpreadsheet,
  Printer,
  Sparkles,
} from 'lucide-react';

interface SuperAdminNetworkOrdersViewProps {
  lang: Language;
}

export const SuperAdminNetworkOrdersView: React.FC<SuperAdminNetworkOrdersViewProps> = ({ lang }) => {
  const isHi = lang === 'hi';
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [selectedDistributorId, setSelectedDistributorId] = useState<string>('all');
  const [searchShopQuery, setSearchShopQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [data, setData] = useState<SuperAdminNetworkOrdersResponse | null>(null);
  const [allDistributorsList, setAllDistributorsList] = useState<DistributorNetworkData[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [expandedShops, setExpandedShops] = useState<Record<number, boolean>>({});

  const loadNetworkOrders = async (dateVal = selectedDate, distVal = selectedDistributorId) => {
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await api.getSuperAdminNetworkOrders(dateVal, distVal);
      setData(res);
      if (distVal === 'all' && res?.distributors) {
        setAllDistributorsList(res.distributors);
      }
      // Automatically expand all shop order item tables by default for visibility
      if (res?.distributors) {
        const initialExpanded: Record<number, boolean> = {};
        res.distributors.forEach((dist) => {
          dist.shop_orders.forEach((so) => {
            initialExpanded[so.order_id] = true;
          });
        });
        setExpandedShops(initialExpanded);
      }
    } catch (err: any) {
      setErrorMsg(err.message || (isHi ? 'ऑर्डर डेटा लोड करने में त्रुटि' : 'Failed to load network orders'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadNetworkOrders(selectedDate, selectedDistributorId);
  }, [selectedDate, selectedDistributorId]);

  const toggleShopExpand = (orderId: number) => {
    setExpandedShops((prev) => ({
      ...prev,
      [orderId]: !prev[orderId],
    }));
  };

  const expandAllShops = (expand: boolean) => {
    if (!data?.distributors) return;
    const newExpanded: Record<number, boolean> = {};
    data.distributors.forEach((d) => {
      d.shop_orders.forEach((so) => {
        newExpanded[so.order_id] = expand;
      });
    });
    setExpandedShops(newExpanded);
  };

  return (
    <div className="space-y-6">
      {/* 1. FILTER & CONTROLS HEADER */}
      <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-800 text-[11px] font-black uppercase tracking-wider border border-emerald-200 mb-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
              <span>{isHi ? 'केंद्रीय नेटवर्क ऑर्डर व आइटम ऑडिट' : 'Live Platform Network Item Audit'}</span>
            </div>
            <h2 className="text-lg sm:text-xl font-black text-slate-900 flex items-center gap-2">
              <Package className="w-5 h-5 text-emerald-700" />
              <span>
                {isHi
                  ? 'वितरक-वार दुकानदारों के ऑर्डर व उत्पाद विवरण'
                  : 'Distributor-wise Shop Orders & Item Breakdown'}
              </span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {isHi
                ? 'देखें किस वितरक के तहत किन दुकानदारों ने कौन-कौन सा उत्पाद, कितनी मात्रा (Qty) व कीमत (Price) पर मंगाया है'
                : 'Monitor exactly which shops ordered which products, item quantities, and line totals under each distributor.'}
            </p>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => expandAllShops(true)}
              className="px-3 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 text-xs font-bold transition"
            >
              {isHi ? 'सभी आइटम खोलें' : 'Expand All'}
            </button>
            <button
              onClick={() => expandAllShops(false)}
              className="px-3 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 text-xs font-bold transition"
            >
              {isHi ? 'सभी समेटें' : 'Collapse All'}
            </button>
            <button
              onClick={() => loadNetworkOrders()}
              disabled={loading}
              className="p-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 transition"
              title={isHi ? 'रिफ्रेश करें' : 'Refresh'}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-emerald-600' : ''}`} />
            </button>
          </div>
        </div>

        {/* Filters Bar: Date, Distributor, Search */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-100">
          {/* Date Picker */}
          <div>
            <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1">
              {isHi ? 'ऑर्डर तिथि चुनें' : 'Select Order Date'}
            </label>
            <div className="relative">
              <Calendar className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-800 bg-slate-50 focus:border-emerald-600 outline-hidden"
              />
            </div>
          </div>

          {/* Distributor Filter */}
          <div>
            <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1">
              {isHi ? 'वितरक चुनें' : 'Filter Distributor'}
            </label>
            <div className="relative">
              <Building2 className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <select
                value={selectedDistributorId}
                onChange={(e) => setSelectedDistributorId(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-800 bg-slate-50 focus:border-emerald-600 outline-hidden"
              >
                <option value="all">{isHi ? 'सभी वितरक (All Distributors)' : 'All Distributors'}</option>
                {(allDistributorsList.length > 0 ? allDistributorsList : (data?.distributors || [])).map((dist, idx) => (
                  <option key={`dist-opt-${dist.distributor_id ?? idx}-${idx}`} value={dist.distributor_id}>
                    {dist.business_name} ({dist.city})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Shop Search Filter */}
          <div>
            <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1">
              {isHi ? 'दुकान या दुकानदार खोजें' : 'Search Shop / Owner'}
            </label>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <input
                type="text"
                value={searchShopQuery}
                onChange={(e) => setSearchShopQuery(e.target.value)}
                placeholder={isHi ? 'दुकान का नाम, कोड या फोन...' : 'Shop name, code or phone...'}
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-800 bg-slate-50 focus:border-emerald-600 outline-hidden"
              />
            </div>
          </div>
        </div>
      </div>

      {/* 2. SUMMARY METRICS RIBBON */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block">
              {isHi ? 'सक्रिय वितरक (ऑर्डर सहित)' : 'Distributors with Orders'}
            </span>
            <div className="text-xl sm:text-2xl font-black text-slate-900 mt-1 flex items-baseline gap-1">
              <span>{data.summary.total_distributors_with_orders}</span>
              <span className="text-xs text-slate-400 font-semibold">
                / {data.distributors.length} {isHi ? 'कुल' : 'total'}
              </span>
            </div>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block">
              {isHi ? 'दुकानदार जिन्होंने ऑर्डर दिया' : 'Ordering Retailers'}
            </span>
            <div className="text-xl sm:text-2xl font-black text-emerald-800 mt-1 flex items-baseline gap-1">
              <Store className="w-4 h-4 text-emerald-600" />
              <span>{data.summary.total_shops_ordered}</span>
              <span className="text-xs text-slate-400 font-semibold">{isHi ? 'दुकानें' : 'shops'}</span>
            </div>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block">
              {isHi ? 'कुल उत्पाद मात्रा (Units/Litre)' : 'Total Items Quantity'}
            </span>
            <div className="text-xl sm:text-2xl font-black text-amber-700 mt-1 flex items-baseline gap-1">
              <Layers className="w-4 h-4 text-amber-600" />
              <span>{data.summary.total_items_quantity.toLocaleString('en-IN')}</span>
              <span className="text-xs text-slate-400 font-semibold">{isHi ? 'इकाइयां' : 'units'}</span>
            </div>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block">
              {isHi ? 'कुल ऑर्डर मूल्य' : 'Total Order Volume'}
            </span>
            <div className="text-xl sm:text-2xl font-black text-emerald-950 mt-1">
              {formatCurrency(data.summary.total_sales_amount)}
            </div>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="p-8 text-center bg-white rounded-3xl border border-slate-200 shadow-xs">
          <RefreshCw className="w-8 h-8 text-emerald-600 animate-spin mx-auto mb-2" />
          <p className="text-xs text-slate-500 font-bold">
            {isHi ? 'नेटवर्क ऑर्डर्स व आइटम विवरण लोड हो रहे हैं...' : 'Loading network orders & items...'}
          </p>
        </div>
      )}

      {/* Error state */}
      {errorMsg && (
        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold">
          {errorMsg}
        </div>
      )}

      {/* 3. DISTRIBUTORS LISTING WITH DETAILED SHOP & PRODUCT BREAKDOWN */}
      {!loading && data && data.distributors.length > 0 && (
        <div className="space-y-6">
          {data.distributors.map((dist, distIdx) => {
            // Apply shop search filter
            const filteredOrders = dist.shop_orders.filter((so) => {
              if (!searchShopQuery.trim()) return true;
              const q = searchShopQuery.toLowerCase();
              return (
                (so.shop_name || '').toLowerCase().includes(q) ||
                (so.owner_name || '').toLowerCase().includes(q) ||
                (so.shop_code || '').toLowerCase().includes(q) ||
                (so.mobile || '').includes(q)
              );
            });

            return (
              <div
                key={`dist-net-${dist.distributor_id ?? distIdx}-${distIdx}`}
                className="bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden"
              >
                {/* Distributor Card Header */}
                <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg sm:text-xl font-black tracking-tight">{dist.business_name}</h3>
                      <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                        {dist.plan_name}
                      </span>
                    </div>
                    <div className="text-xs text-slate-300 flex flex-wrap items-center gap-3">
                      <span>
                        {isHi ? 'संचालक:' : 'Owner:'} <strong className="text-white">{dist.owner_name}</strong>
                      </span>
                      <span>•</span>
                      <span>
                        {isHi ? 'शहर:' : 'City:'} <strong className="text-white">{dist.city}</strong>
                      </span>
                      <span>•</span>
                      <span className="flex items-center gap-1 font-mono">
                        <Phone className="w-3 h-3 text-slate-400" />
                        <span>{dist.mobile}</span>
                      </span>
                    </div>
                  </div>

                  {/* Distributor Aggregated Volume Badges */}
                  <div className="flex items-center gap-3">
                    <div className="bg-white/10 backdrop-blur-md px-3.5 py-2 rounded-2xl border border-white/15 text-right">
                      <span className="text-[10px] text-slate-300 block font-bold">
                        {isHi ? 'दुकानों के ऑर्डर्स' : 'Shops Ordered'}
                      </span>
                      <span className="text-base font-black text-amber-300">
                        {dist.shops_ordering_count} {isHi ? 'दुकानें' : 'shops'}
                      </span>
                    </div>

                    <div className="bg-emerald-500/20 backdrop-blur-md px-3.5 py-2 rounded-2xl border border-emerald-400/30 text-right">
                      <span className="text-[10px] text-emerald-200 block font-bold">
                        {isHi ? 'कुल उत्पाद मात्रा' : 'Total Units'}
                      </span>
                      <span className="text-base font-black text-white">
                        {dist.total_items_quantity.toLocaleString('en-IN')} {isHi ? 'नग' : 'qty'}
                      </span>
                    </div>

                    <div className="bg-white/10 backdrop-blur-md px-3.5 py-2 rounded-2xl border border-white/15 text-right">
                      <span className="text-[10px] text-slate-300 block font-bold">
                        {isHi ? 'कुल बिक्री मूल्य' : 'Total Amount'}
                      </span>
                      <span className="text-base font-black text-emerald-300">
                        {formatCurrency(dist.total_sales_amount)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Distributor Content Sections */}
                <div className="p-5 sm:p-6 space-y-6">
                  {/* A. CONSOLIDATED PRODUCTS DEMAND MATRIX FOR THIS DISTRIBUTOR */}
                  {dist.consolidated_items && dist.consolidated_items.length > 0 ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-black text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5 text-emerald-700" />
                          <span>
                            {isHi
                              ? `उत्पाद मांग एकत्रीकरण (${dist.consolidated_items.length} उत्पाद)`
                              : `Consolidated Product Demand (${dist.consolidated_items.length} items)`}
                          </span>
                        </h4>
                        <span className="text-[11px] text-slate-400 font-bold">
                          {isHi
                            ? 'इस वितरक के सभी दुकानदारों की कुल एकत्रित मांग'
                            : 'Aggregate demand across all shops of this distributor'}
                        </span>
                      </div>

                      <div className="overflow-x-auto border border-slate-200 rounded-2xl">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-50 text-slate-700 font-extrabold border-b border-slate-200">
                            <tr>
                              <th className="p-2.5">#</th>
                              <th className="p-2.5">{isHi ? 'डेयरी उत्पाद (Product)' : 'Product Name'}</th>
                              <th className="p-2.5">{isHi ? 'श्रेणी' : 'Category'}</th>
                              <th className="p-2.5">{isHi ? 'इकाई' : 'Unit'}</th>
                              <th className="p-2.5 text-right">{isHi ? 'दर (Rate)' : 'Unit Price'}</th>
                              <th className="p-2.5 text-center bg-amber-50 text-amber-900 font-black">
                                {isHi ? 'कुल मंगाया (Ordered Qty)' : 'Ordered Qty'}
                              </th>
                              <th className="p-2.5 text-center">{isHi ? 'आपूर्ति (Delivered)' : 'Delivered Qty'}</th>
                              <th className="p-2.5 text-center">{isHi ? 'दुकानें' : 'Shops'}</th>
                              <th className="p-2.5 text-right font-black">{isHi ? 'कुल राशि' : 'Line Total'}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {dist.consolidated_items.map((item, idx) => (
                              <tr key={`cons-prod-${item.product_id ?? idx}-${idx}`} className="hover:bg-slate-50/70 transition">
                                <td className="p-2.5 font-mono text-slate-400">{idx + 1}</td>
                                <td className="p-2.5 font-black text-slate-900">
                                  <span>{isHi ? item.name_hindi : item.name_english}</span>
                                  {isHi && (
                                    <span className="block text-[10px] text-slate-400 font-normal">
                                      {item.name_english}
                                    </span>
                                  )}
                                </td>
                                <td className="p-2.5">
                                  <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-bold text-[10px]">
                                    {item.category}
                                  </span>
                                </td>
                                <td className="p-2.5 text-slate-600 font-bold">{item.unit}</td>
                                <td className="p-2.5 text-right font-mono text-slate-700">
                                  {formatCurrency(item.price)}
                                </td>
                                <td className="p-2.5 text-center bg-amber-50/80 font-black text-sm text-amber-900">
                                  {item.total_ordered_qty} {item.unit}
                                </td>
                                <td className="p-2.5 text-center font-bold text-slate-700">
                                  {item.total_delivered_qty} {item.unit}
                                </td>
                                <td className="p-2.5 text-center font-bold text-slate-600">
                                  {item.shops_count}
                                </td>
                                <td className="p-2.5 text-right font-black text-emerald-900">
                                  {formatCurrency(item.total_amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 rounded-2xl bg-slate-50 border border-dashed border-slate-200 text-center text-xs text-slate-400">
                      {isHi
                        ? 'इस तारीख के लिए इस वितरक के पास कोई ऑर्डर दर्ज नहीं है।'
                        : 'No orders placed under this distributor on this date.'}
                    </div>
                  )}

                  {/* B. SHOPKEEPER-BY-SHOPKEEPER ORDERED ITEMS BREAKDOWN */}
                  {filteredOrders.length > 0 && (
                    <div className="space-y-3 pt-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                          <Store className="w-3.5 h-3.5 text-blue-700" />
                          <span>
                            {isHi
                              ? `दुकानदार-वार ऑर्डर व सामान की सूची (${filteredOrders.length} दुकानें)`
                              : `Shopkeeper-wise Order Slips (${filteredOrders.length} shops)`}
                          </span>
                        </h4>
                        <span className="text-[11px] text-slate-500 font-medium">
                          {isHi ? 'प्रत्येक दुकान का ऑर्डर और उसमें मंगाया गया हर आइटम' : 'Detailed order items per shopkeeper'}
                        </span>
                      </div>

                      <div className="space-y-3">
                        {filteredOrders.map((shopOrder, soIdx) => {
                          const isExpanded = expandedShops[shopOrder.order_id] ?? true;

                          return (
                            <div
                              key={`shop-ord-${shopOrder.order_id ?? soIdx}-${soIdx}`}
                              className="border border-slate-200 rounded-2xl overflow-hidden hover:border-slate-300 transition"
                            >
                              {/* Shop Row Header */}
                              <div
                                onClick={() => toggleShopExpand(shopOrder.order_id)}
                                className="p-3.5 sm:p-4 bg-slate-50 hover:bg-slate-100/70 cursor-pointer flex flex-wrap items-center justify-between gap-3 transition"
                              >
                                <div className="flex items-center gap-3">
                                  <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-950 font-black text-xs border border-emerald-200">
                                    {shopOrder.shop_code}
                                  </span>
                                  <div>
                                    <h5 className="font-black text-sm text-slate-900">{shopOrder.shop_name}</h5>
                                    <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-2">
                                      <span>
                                        {isHi ? 'दुकानदार:' : 'Owner:'} <strong className="text-slate-700">{shopOrder.owner_name}</strong>
                                      </span>
                                      <span>•</span>
                                      <span className="font-mono">{shopOrder.mobile}</span>
                                      <span>•</span>
                                      <span className="flex items-center gap-1 text-slate-600 font-bold">
                                        <Truck className="w-3 h-3 text-slate-400" />
                                        <span>{shopOrder.route}</span>
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                <div className="flex items-center gap-4">
                                  <div className="text-right">
                                    <span className="text-[10px] text-slate-400 font-bold block">
                                      {shopOrder.items.length} {isHi ? 'आइटम मंगाए' : 'items'}
                                    </span>
                                    <span className="text-sm font-black text-emerald-900">
                                      {formatCurrency(shopOrder.total_amount)}
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                                        shopOrder.status === 'Delivered'
                                          ? 'bg-emerald-100 text-emerald-800'
                                          : shopOrder.status === 'Confirmed'
                                          ? 'bg-blue-100 text-blue-800'
                                          : 'bg-amber-100 text-amber-800'
                                      }`}
                                    >
                                      {shopOrder.status}
                                    </span>
                                    <button
                                      type="button"
                                      className="p-1 text-slate-400 hover:text-slate-600 transition"
                                    >
                                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                    </button>
                                  </div>
                                </div>
                              </div>

                              {/* Shop Ordered Items Table */}
                              {isExpanded && (
                                <div className="p-3 sm:p-4 bg-white border-t border-slate-100">
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-left text-xs">
                                      <thead className="bg-slate-50/80 text-slate-600 font-extrabold border-b border-slate-200">
                                        <tr>
                                          <th className="p-2">#</th>
                                          <th className="p-2">{isHi ? 'सामान का नाम (Product)' : 'Item Name'}</th>
                                          <th className="p-2">{isHi ? 'श्रेणी' : 'Category'}</th>
                                          <th className="p-2 text-right">{isHi ? 'दर (Price)' : 'Rate'}</th>
                                          <th className="p-2 text-center bg-emerald-50 text-emerald-950 font-black">
                                            {isHi ? 'मंगाई गई मात्रा (Qty)' : 'Ordered Qty'}
                                          </th>
                                          <th className="p-2 text-center">{isHi ? 'सप्लाई (Delivered)' : 'Delivered'}</th>
                                          <th className="p-2 text-right font-black">{isHi ? 'कुल राशि' : 'Line Total'}</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {shopOrder.items.map((it, itemIdx) => (
                                          <tr key={`shop-it-${it.product_id ?? itemIdx}-${itemIdx}`} className="hover:bg-slate-50/50">
                                            <td className="p-2 font-mono text-slate-400">{itemIdx + 1}</td>
                                            <td className="p-2 font-bold text-slate-800">
                                              <span>{isHi ? it.name_hindi : it.name_english}</span>
                                              {isHi && (
                                                <span className="block text-[10px] text-slate-400 font-normal">
                                                  {it.name_english}
                                                </span>
                                              )}
                                            </td>
                                            <td className="p-2 text-slate-500 font-medium">{it.category}</td>
                                            <td className="p-2 text-right font-mono text-slate-600">
                                              {formatCurrency(it.unit_price)}
                                            </td>
                                            <td className="p-2 text-center bg-emerald-50 font-black text-emerald-900">
                                              {it.ordered_quantity} {it.unit}
                                            </td>
                                            <td className="p-2 text-center font-bold text-slate-700">
                                              {it.delivered_quantity} {it.unit}
                                            </td>
                                            <td className="p-2 text-right font-black text-slate-900">
                                              {formatCurrency(it.line_total)}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                      <tfoot className="border-t border-slate-200 bg-slate-50/80 font-black">
                                        <tr>
                                          <td colSpan={4} className="p-2 text-right text-slate-700">
                                            {isHi ? 'कुल योग (Total):' : 'Grand Total:'}
                                          </td>
                                          <td className="p-2 text-center text-emerald-950 bg-emerald-100/60 font-black">
                                            {shopOrder.items.reduce((s, x) => s + x.ordered_quantity, 0)} {isHi ? 'नग' : 'qty'}
                                          </td>
                                          <td className="p-2 text-center text-slate-700">
                                            {shopOrder.items.reduce((s, x) => s + x.delivered_quantity, 0)}
                                          </td>
                                          <td className="p-2 text-right text-sm text-emerald-900">
                                            {formatCurrency(shopOrder.total_amount)}
                                          </td>
                                        </tr>
                                      </tfoot>
                                    </table>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty network state */}
      {!loading && (!data || data.distributors.length === 0) && (
        <div className="p-12 text-center bg-white rounded-3xl border border-slate-200 shadow-xs space-y-2">
          <Store className="w-12 h-12 text-slate-300 mx-auto" />
          <h4 className="text-base font-extrabold text-slate-800">
            {isHi ? 'कोई ऑर्डर नहीं मिला' : 'No Network Orders Found'}
          </h4>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            {isHi
              ? 'चुनी गई तिथि पर किसी भी वितरक के दुकानदारों का ऑर्डर उपलब्ध नहीं है। कृपया कोई अन्य तिथि चुनें।'
              : 'No retailer orders were placed on the selected date. Please choose another date.'}
          </p>
        </div>
      )}
    </div>
  );
};

export default SuperAdminNetworkOrdersView;