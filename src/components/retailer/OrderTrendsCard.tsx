import React, { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import {
  TrendingUp,
  Package,
  IndianRupee,
  Calendar,
  Activity,
  Layers,
  ArrowUpRight,
  Clock,
} from 'lucide-react';
import { Order, OrderItem } from '../../types/index.ts';
import { Language, formatCurrency } from '../../utils/i18n.ts';

interface OrderTrendsCardProps {
  orders: Order[];
  lang: Language;
}

type MetricType = 'volume' | 'amount' | 'combined';
type RangeDays = 7 | 14 | 30;

export const OrderTrendsCard: React.FC<OrderTrendsCardProps> = ({ orders, lang }) => {
  const isHi = lang === 'hi';
  const [metric, setMetric] = useState<MetricType>('volume');
  const [selectedRange, setSelectedRange] = useState<RangeDays>(30);

  // Generate 30 consecutive calendar dates in IST ending today
  const chartData = useMemo(() => {
    const list: Array<{
      date: string;
      displayDate: string;
      shortDate: string;
      volume: number;
      amount: number;
      orderCount: number;
      itemsCount: number;
    }> = [];

    const now = new Date();
    // Helper to get IST date string 'YYYY-MM-DD'
    const getISTDate = (d: Date) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
      return parts;
    };

    // Index non-cancelled orders by date
    const ordersByDate = new Map<string, Order[]>();
    (orders || []).forEach((ord) => {
      if (ord.status === 'Cancelled') return;
      const d = ord.order_date;
      if (!d) return;
      if (!ordersByDate.has(d)) {
        ordersByDate.set(d, []);
      }
      ordersByDate.get(d)!.push(ord);
    });

    const monthNamesEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthNamesHi = ['जन', 'फ़र', 'मार्च', 'अप्रै', 'मई', 'जून', 'जुला', 'अग', 'सित', 'अक्तू', 'नव', 'दिस'];

    // Generate dates for the selected range (7, 14, or 30 days)
    for (let i = selectedRange - 1; i >= 0; i--) {
      const targetTime = new Date(now.getTime() - i * 86400000);
      const dateKey = getISTDate(targetTime);

      const dayNum = parseInt(dateKey.slice(8, 10), 10);
      const monthNum = parseInt(dateKey.slice(5, 7), 10) - 1;
      const monthStr = isHi ? monthNamesHi[monthNum] : monthNamesEn[monthNum];
      const displayDate = `${dayNum} ${monthStr}`;
      const shortDate = `${dayNum}/${monthNum + 1}`;

      const dayOrders = ordersByDate.get(dateKey) || [];

      let dayVolume = 0;
      let dayAmount = 0;
      let dayItemsCount = 0;

      dayOrders.forEach((o) => {
        dayAmount += Number(o.total_amount) || 0;
        if (Array.isArray(o.items) && o.items.length > 0) {
          o.items.forEach((it: OrderItem) => {
            const qty = Number(it.delivered_quantity != null && (o.status === 'Delivered' || o.status === 'Partially Delivered')
              ? it.delivered_quantity
              : (it.ordered_quantity || (it as any).quantity || 0));
            dayVolume += qty;
            dayItemsCount++;
          });
        } else {
          // Fallback if individual items are not expanded: estimate based on subtotal or count 1 crate approx
          dayVolume += 1;
        }
      });

      list.push({
        date: dateKey,
        displayDate,
        shortDate,
        volume: dayVolume,
        amount: Math.round(dayAmount * 100) / 100,
        orderCount: dayOrders.length,
        itemsCount: dayItemsCount,
      });
    }

    return list;
  }, [orders, selectedRange, isHi]);

  // Aggregate summary metrics across the selected window
  const stats = useMemo(() => {
    let totalVolume = 0;
    let totalSpend = 0;
    let activeDays = 0;
    let totalOrders = 0;

    chartData.forEach((d) => {
      totalVolume += d.volume;
      totalSpend += d.amount;
      totalOrders += d.orderCount;
      if (d.orderCount > 0) {
        activeDays++;
      }
    });

    const avgDailyVolume = activeDays > 0 ? Math.round((totalVolume / activeDays) * 10) / 10 : 0;
    const avgDailySpend = activeDays > 0 ? Math.round(totalSpend / activeDays) : 0;

    return {
      totalVolume,
      totalSpend,
      activeDays,
      totalOrders,
      avgDailyVolume,
      avgDailySpend,
      consistencyPct: Math.round((activeDays / selectedRange) * 100),
    };
  }, [chartData, selectedRange]);

  // Custom Recharts Tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const dataPoint = payload[0].payload;
      return (
        <div className="bg-slate-900/95 text-white p-3 rounded-2xl shadow-xl border border-slate-700/60 backdrop-blur-md text-xs min-w-[180px] pointer-events-none z-50">
          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-2">
            <span className="font-extrabold text-slate-200 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              {dataPoint.displayDate}
            </span>
            <span className="text-[10px] font-mono text-slate-400">
              {dataPoint.date}
            </span>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1">
                <Package className="w-3.5 h-3.5 text-emerald-400" />
                {isHi ? 'कुल मात्रा:' : 'Volume (Qty):'}
              </span>
              <span className="font-black text-emerald-300 text-sm">
                {dataPoint.volume} {isHi ? 'यूनिट्स' : 'Units'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1">
                <IndianRupee className="w-3.5 h-3.5 text-teal-400" />
                {isHi ? 'ऑर्डर मूल्य:' : 'Order Value:'}
              </span>
              <span className="font-black text-teal-300 text-sm">
                {formatCurrency(dataPoint.amount)}
              </span>
            </div>

            <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-800/80 text-slate-400">
              <span>{isHi ? 'कुल ऑर्डर्स:' : 'Orders Placed:'}</span>
              <span className="font-bold text-white">
                {dataPoint.orderCount} {isHi ? 'ऑर्डर' : 'orders'}
              </span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-white rounded-3xl border border-slate-200/90 p-4 sm:p-6 shadow-xs space-y-4 transition-all">
      {/* Header section with title and controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3.5">
        <div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 text-[11px] font-bold border border-emerald-200/80 mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
            <span>{isHi ? 'दुकानदार एनालिटिक्स' : 'Retailer Analytics'}</span>
          </div>
          <h3 className="font-black text-base sm:text-lg text-slate-900 tracking-tight flex items-center gap-2">
            <span>{isHi ? 'दैनिक ऑर्डर वॉल्यूम ट्रेंड' : 'Order Volume & Supply Trends'}</span>
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {isHi
              ? `पिछले ${selectedRange} दिनों में दूध एवं डेयरी उत्पादों के ऑर्डर का दैनिक रुझान`
              : `Daily order volume and spend trends across the last ${selectedRange} days`}
          </p>
        </div>

        {/* Range and Metric View Switchers */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Day Range Filter */}
          <div className="inline-flex items-center p-1 bg-slate-100 rounded-xl text-xs font-bold text-slate-600">
            <button
              type="button"
              onClick={() => setSelectedRange(7)}
              className={`px-2.5 py-1 rounded-lg transition ${
                selectedRange === 7
                  ? 'bg-white text-emerald-800 shadow-xs'
                  : 'hover:text-slate-900'
              }`}
            >
              7D
            </button>
            <button
              type="button"
              onClick={() => setSelectedRange(14)}
              className={`px-2.5 py-1 rounded-lg transition ${
                selectedRange === 14
                  ? 'bg-white text-emerald-800 shadow-xs'
                  : 'hover:text-slate-900'
              }`}
            >
              14D
            </button>
            <button
              type="button"
              onClick={() => setSelectedRange(30)}
              className={`px-2.5 py-1 rounded-lg transition ${
                selectedRange === 30
                  ? 'bg-white text-emerald-800 shadow-xs'
                  : 'hover:text-slate-900'
              }`}
            >
              30D
            </button>
          </div>

          {/* Metric Selector */}
          <div className="inline-flex items-center p-1 bg-slate-100 rounded-xl text-xs font-bold text-slate-600">
            <button
              type="button"
              onClick={() => setMetric('volume')}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg transition ${
                metric === 'volume'
                  ? 'bg-emerald-700 text-white shadow-xs'
                  : 'hover:text-slate-900'
              }`}
            >
              <Package className="w-3.5 h-3.5" />
              <span>{isHi ? 'मात्रा' : 'Volume'}</span>
            </button>
            <button
              type="button"
              onClick={() => setMetric('amount')}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg transition ${
                metric === 'amount'
                  ? 'bg-teal-700 text-white shadow-xs'
                  : 'hover:text-slate-900'
              }`}
            >
              <IndianRupee className="w-3.5 h-3.5" />
              <span>{isHi ? 'राशि (₹)' : 'Value (₹)'}</span>
            </button>
            <button
              type="button"
              onClick={() => setMetric('combined')}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg transition ${
                metric === 'combined'
                  ? 'bg-slate-800 text-white shadow-xs'
                  : 'hover:text-slate-900'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{isHi ? 'दोनों' : 'Both'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Quick KPI Stat Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3">
        <div className="p-3 bg-emerald-50/70 border border-emerald-200/60 rounded-2xl">
          <div className="flex items-center justify-between text-emerald-700 text-[11px] font-bold">
            <span>{isHi ? `${selectedRange}-दिन कुल मात्रा` : `${selectedRange}D Total Volume`}</span>
            <Package className="w-3.5 h-3.5" />
          </div>
          <div className="text-lg sm:text-xl font-black text-emerald-950 mt-1">
            {stats.totalVolume.toLocaleString('en-IN')} <span className="text-xs font-bold text-emerald-700">{isHi ? 'यूनिट्स' : 'units'}</span>
          </div>
          <div className="text-[10px] text-emerald-800/80 mt-0.5">
            {stats.avgDailyVolume} {isHi ? 'यूनिट / सक्रिय दिन' : 'units / active day'}
          </div>
        </div>

        <div className="p-3 bg-teal-50/70 border border-teal-200/60 rounded-2xl">
          <div className="flex items-center justify-between text-teal-700 text-[11px] font-bold">
            <span>{isHi ? `${selectedRange}-दिन कुल खरीद` : `${selectedRange}D Total Spend`}</span>
            <IndianRupee className="w-3.5 h-3.5" />
          </div>
          <div className="text-lg sm:text-xl font-black text-teal-950 mt-1">
            {formatCurrency(stats.totalSpend)}
          </div>
          <div className="text-[10px] text-teal-800/80 mt-0.5">
            {formatCurrency(stats.avgDailySpend)} {isHi ? 'औसत / सक्रिय दिन' : 'avg / active day'}
          </div>
        </div>

        <div className="p-3 bg-amber-50/70 border border-amber-200/60 rounded-2xl">
          <div className="flex items-center justify-between text-amber-700 text-[11px] font-bold">
            <span>{isHi ? 'ऑर्डर कंसिस्टेंसी' : 'Order Regularity'}</span>
            <Activity className="w-3.5 h-3.5" />
          </div>
          <div className="text-lg sm:text-xl font-black text-amber-950 mt-1">
            {stats.activeDays} <span className="text-xs font-bold text-amber-800">/ {selectedRange} {isHi ? 'दिन' : 'days'}</span>
          </div>
          <div className="text-[10px] text-amber-800/80 mt-0.5">
            {stats.consistencyPct}% {isHi ? 'नियमितता स्कोर' : 'daily regularity'}
          </div>
        </div>

        <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-2xl">
          <div className="flex items-center justify-between text-slate-600 text-[11px] font-bold">
            <span>{isHi ? 'कुल ऑर्डर संख्या' : 'Total Orders Placed'}</span>
            <Clock className="w-3.5 h-3.5 text-slate-500" />
          </div>
          <div className="text-lg sm:text-xl font-black text-slate-900 mt-1">
            {stats.totalOrders} <span className="text-xs font-bold text-slate-600">{isHi ? 'ऑर्डर्स' : 'orders'}</span>
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            {isHi ? 'स्वीकृत व डिलीवर' : 'Recorded in system'}
          </div>
        </div>
      </div>

      {/* Main Recharts Chart Area */}
      <div className="w-full h-64 sm:h-72 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          {metric === 'volume' ? (
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
              <defs>
                <linearGradient id="colorVolume" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#059669" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#059669" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="shortDate"
                stroke="#94a3b8"
                fontSize={11}
                tickLine={false}
                axisLine={{ stroke: '#e2e8f0' }}
                interval={selectedRange === 30 ? 3 : selectedRange === 14 ? 1 : 0}
              />
              <YAxis
                stroke="#94a3b8"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="volume"
                name={isHi ? 'मात्रा (यूनिट्स)' : 'Quantity (Units)'}
                stroke="#059669"
                strokeWidth={2.5}
                fillOpacity={1}
                fill="url(#colorVolume)"
                activeDot={{ r: 5, fill: '#059669', stroke: '#ffffff', strokeWidth: 2 }}
              />
            </AreaChart>
          ) : metric === 'amount' ? (
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="colorAmount" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0d9488" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#0d9488" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="shortDate"
                stroke="#94a3b8"
                fontSize={11}
                tickLine={false}
                axisLine={{ stroke: '#e2e8f0' }}
                interval={selectedRange === 30 ? 3 : selectedRange === 14 ? 1 : 0}
              />
              <YAxis
                stroke="#94a3b8"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `₹${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="amount"
                name={isHi ? 'ऑर्डर मूल्य (₹)' : 'Order Value (₹)'}
                stroke="#0d9488"
                strokeWidth={2.5}
                fillOpacity={1}
                fill="url(#colorAmount)"
                activeDot={{ r: 5, fill: '#0d9488', stroke: '#ffffff', strokeWidth: 2 }}
              />
            </AreaChart>
          ) : (
            <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="shortDate"
                stroke="#94a3b8"
                fontSize={11}
                tickLine={false}
                axisLine={{ stroke: '#e2e8f0' }}
                interval={selectedRange === 30 ? 3 : selectedRange === 14 ? 1 : 0}
              />
              <YAxis
                yAxisId="left"
                stroke="#059669"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#0d9488"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `₹${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                formatter={(val) => <span className="text-slate-700 font-bold">{val}</span>}
              />
              <Bar
                yAxisId="left"
                dataKey="volume"
                name={isHi ? 'मात्रा (यूनिट्स)' : 'Volume (Units)'}
                fill="#059669"
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="amount"
                name={isHi ? 'मूल्य (₹)' : 'Value (₹)'}
                stroke="#0d9488"
                strokeWidth={2}
                dot={{ r: 2 }}
              />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Footer Insight Note */}
      <div className="flex flex-wrap items-center justify-between text-xs text-slate-500 pt-1 border-t border-slate-100 gap-2">
        <div className="flex items-center gap-1.5 font-medium">
          <ArrowUpRight className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <span>
            {isHi
              ? 'कटऑफ समय (शाम 8:00 बजे) से पहले दिए गए सभी नियमित व आपातकालीन ऑर्डर यहाँ संकलित हैं।'
              : 'Includes daily regular morning milk pouches, curd crates, paneer, and FMCG supplies.'}
          </span>
        </div>
        <div className="font-bold text-slate-700 text-[11px]">
          {isHi ? 'अद्यतन: रीयल-टाइम' : 'Live Real-Time Sync'}
        </div>
      </div>
    </div>
  );
};
