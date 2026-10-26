/**
 * WhatsApp Share & Message Utilities for VedirtSetu
 */

export function formatOrderWhatsAppMessage(order: any, shopName?: string, lang: 'hi' | 'en' = 'en'): string {
  const isHi = lang === 'hi';
  const shop = shopName || order.shop_name || 'Retailer';
  const isPartial = order.status === 'Partially Delivered';

  const statusHindiMap: Record<string, string> = {
    'Pending': 'लंबित (Pending)',
    'Confirmed': 'स्वीकृत (Confirmed)',
    'Packed': 'पैक हो गया (Packed)',
    'Partially Delivered': 'आंशिक डिलीवरी (Partially Delivered)',
    'Delivered': 'डिलीवर हो गया (Delivered)',
    'Cancelled': 'रद्द (Cancelled)',
  };
  const statusDisplay = isHi ? (statusHindiMap[order.status] || order.status) : order.status;

  const itemsText = (order.items || [])
    .map((it: any, idx: number) => {
      const pName = isHi && it.name_hindi ? it.name_hindi : (it.name_english || it.product_name || (isHi ? 'उत्पाद' : 'Item'));
      const unit = it.unit || 'pkt';
      const ordQty = it.ordered_quantity ?? it.quantity ?? 0;
      const delivQty = it.delivered_quantity;

      if ((isPartial || order.status === 'Delivered') && delivQty != null && delivQty !== ordQty) {
        const total = it.line_total ?? (delivQty * (it.unit_price || 0));
        return isHi
          ? `${idx + 1}. *${pName}*: ${delivQty} ${unit} डिलीवर (ऑर्डर: ${ordQty} ${unit}) — ₹${total}`
          : `${idx + 1}. *${pName}*: ${delivQty} ${unit} Deliv (Ord: ${ordQty} ${unit}) — ₹${total}`;
      } else {
        const qty = (order.status === 'Delivered' && delivQty != null && delivQty > 0) ? delivQty : ordQty;
        const total = it.line_total ?? (qty * (it.unit_price || 0));
        return `${idx + 1}. *${pName}*: ${qty} ${unit} (₹${total})`;
      }
    })
    .join('\n');

  const text = isHi
    ? `📦 *वेदिरतसेतु B2B ऑर्डर रसीद (Order Slip)*\n` +
      `🔖 *ऑर्डर संख्या:* #${order.order_number}\n` +
      `🏪 *दुकान:* ${shop} ${order.shop_code ? `(${order.shop_code})` : ''}\n` +
      `📅 *दिनांक:* ${order.order_date}\n` +
      `🚚 *स्थिति:* ${statusDisplay}\n\n` +
      `📋 *सामग्री व मात्रा:*\n${itemsText || 'विवरण उपलब्ध नहीं'}\n\n` +
      `💰 *कुल राशि:* ₹${order.total_amount}\n` +
      `---------------------------\n` +
      `_वेदिरतसेतु B2B थोक ऑर्डर व वितरण नेटवर्क_`
    : `📦 *VedirtSetu B2B Order Slip*\n` +
      `🔖 *Order #:* #${order.order_number}\n` +
      `🏪 *Shop:* ${shop} ${order.shop_code ? `(${order.shop_code})` : ''}\n` +
      `📅 *Date:* ${order.order_date}\n` +
      `🚚 *Status:* ${statusDisplay}\n\n` +
      `📋 *Order Items & Quantities:*\n${itemsText || 'No items listed'}\n\n` +
      `💰 *Total Amount:* ₹${order.total_amount}\n` +
      `---------------------------\n` +
      `_Powered by VedirtSetu B2B Wholesale Ordering System_`;

  return encodeURIComponent(text);
}

export function openWhatsAppShare(encodedMessage: string, mobile?: string) {
  const rawDigits = mobile ? String(mobile).replace(/\D/g, '') : '';
  const cleanMobile = rawDigits.length >= 10 ? rawDigits.slice(-10) : rawDigits;
  const url = cleanMobile
    ? `https://wa.me/91${cleanMobile}?text=${encodedMessage}`
    : `https://wa.me/?text=${encodedMessage}`;
  window.open(url, '_blank');
}