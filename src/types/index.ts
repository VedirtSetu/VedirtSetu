export type UserRole = 'superadmin' | 'admin' | 'retailer';

export type SubscriptionStatus = 'active' | 'trial' | 'expired' | 'suspended' | 'deleted';

export type OrderStatus = 'Pending' | 'Confirmed' | 'Packed' | 'Partially Delivered' | 'Delivered' | 'Cancelled';

export type CutoffStatus = 'on_time' | 'late' | 'exempt';

export type PaymentMode = 'Cash' | 'UPI' | 'Cheque' | 'Bank Transfer';

export interface User {
  id: number;
  name: string;
  mobile: string;
  email: string;
  role: UserRole;
  active_status: number;
  created_at: string;
  shop_id?: number;
  shop_name?: string;
  shop_code?: string;
  distributor_id?: number;
  business_name?: string;
  plan_name?: string;
  subscription_status?: SubscriptionStatus;
  max_shops?: number;
  area?: string;
  route?: string;
  address?: string;
}

export interface Distributor {
  id: number;
  user_id: number;
  business_name: string;
  owner_name: string;
  mobile: string;
  email: string;
  city: string;
  address?: string;
  plan_name: string;
  monthly_fee: number;
  subscription_status: SubscriptionStatus;
  subscription_start_date: string;
  subscription_renewal_date: string;
  max_shops: number;
  payment_status: 'paid' | 'due' | 'overdue' | 'pending_verification';
  notes?: string;
  created_at: string;
  login_pin?: string;
  active_status?: number;
  is_deleted?: number | boolean;
  is_demo?: number;
  // Computed / aggregated
  shops_count?: number;
  today_orders_count?: number;
  today_sales_amount?: number;
  unsubmitted_count?: number;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  name_hi: string;
  monthly_fee: number;
  yearly_fee: number;
  max_shops: number;
  description: string;
  description_en: string;
  features_hi: string[];
  features_en: string[];
  popular: boolean | number;
  is_active?: boolean | number;
  updated_at?: string;
}

export interface SubscriptionPayment {
  id: number;
  distributor_id: number;
  business_name?: string;
  owner_name?: string;
  city?: string;
  plan_name?: string;
  amount: number;
  payment_date: string;
  period_start: string;
  period_end: string;
  payment_mode: string;
  reference_no?: string;
  notes?: string;
  status?: 'pending' | 'approved' | 'rejected';
  duration_months?: number;
  created_at: string;
}

export interface SuperAdminMetrics {
  total_distributors: number;
  active_distributors: number;
  trial_distributors: number;
  expired_distributors: number;
  total_mrr: number;
  total_shops_network: number;
  total_today_orders: number;
  total_today_sales: number;
  renewals_due_this_week: number;
}

export interface DistributorShopItem {
  id: number;
  shop_code: string;
  shop_name: string;
  owner_name: string;
  mobile: string;
  address: string;
  area: string;
  route: string;
  balance: number;
  outstanding_balance?: number;
  cutoff_exempt: number;
  active_status: number;
  created_at: string;
  today_order_id?: number;
  today_order_status?: OrderStatus | 'Not Ordered';
  today_order_amount?: number;
  last_order_date?: string;
}

export interface DistributorMonitoringData {
  distributor: Distributor;
  shops: DistributorShopItem[];
  stats: {
    total_shops: number;
    active_shops_7d: number;
    total_balance: number;
    today_orders_count: number;
    today_sales_amount: number;
    plan_usage_percentage: number;
  };
}

export interface Shop {
  id: number;
  shop_code: string;
  shop_name: string;
  owner_name: string;
  mobile: string;
  address: string;
  area: string;
  route: string;
  assigned_user_id: number;
  distributor_id?: number;
  active_status: number;
  created_at: string;
  today_order_status?: OrderStatus | 'Not Ordered';
  today_order_id?: number;
  outstanding_balance?: number;
  login_pin?: string;
}

export interface Product {
  id: number;
  name_english: string;
  name_hindi: string;
  name?: string;
  name_hi?: string;
  category: string;
  unit: string;
  price: number;
  minimum_quantity: number;
  stock_available: number;
  active_status: number;
  display_order: number;
  custom_price?: number; // shop-specific override
  distributor_id?: number;
}

export interface OrderItem {
  id?: number;
  order_id?: number;
  product_id: number;
  ordered_quantity: number;
  delivered_quantity: number;
  unit_price: number;
  line_total: number;
  name_english?: string;
  name_hindi?: string;
  unit?: string;
  category?: string;
}

export interface Order {
  id: number;
  order_number: string;
  shop_id: number;
  created_by: number;
  order_date: string;
  status: OrderStatus;
  subtotal: number;
  total_amount: number;
  cutoff_status: CutoffStatus;
  notes: string;
  created_at: string;
  updated_at: string;
  confirmed_at?: string | null;
  delivered_at?: string | null;
  shop_name?: string;
  shop_code?: string;
  owner_name?: string;
  mobile?: string;
  route?: string;
  area?: string;
  distributor_id?: number;
  items?: OrderItem[];
}

export interface Payment {
  id: number;
  shop_id: number;
  order_id?: number | null;
  amount: number;
  payment_date: string;
  payment_mode: PaymentMode;
  notes: string;
  status?: 'pending' | 'approved' | 'rejected';
  shop_name?: string;
  shop_code?: string;
  created_at: string;
}

export interface Notification {
  id: number;
  user_id: number;
  title: string;
  message: string;
  read_status: number;
  created_at: string;
}

export interface AuditLog {
  id: number;
  user_id: number;
  user_name?: string;
  action: string;
  entity_type: string;
  entity_id: number;
  old_value?: string;
  new_value?: string;
  reason?: string;
  created_at: string;
}

export interface SystemSettings {
  cutoff_time: string; // e.g. "20:00"
  allow_late_orders: boolean;
  distributor_name: string;
  distributor_mobile: string;
  distributor_upi: string;
  distributor_qr_image?: string;
  platform_upi_id?: string;
  platform_qr_image?: string;
  platform_owner_name?: string;
  platform_owner_email?: string;
}

export interface RetailerDistributorInfo {
  distributor: {
    id: number;
    business_name: string;
    owner_name: string;
    mobile: string;
    email: string;
    city: string;
    address: string;
    upi_id: string;
    qr_image?: string;
    notes?: string;
  } | null;
  shop: {
    id: number;
    shop_code: string;
    shop_name: string;
    owner_name: string;
    mobile: string;
    route: string;
    area: string;
  } | null;
  cutoff_time: string;
  allow_late_orders: boolean;
}

export interface ConsolidatedItem {
  product_id: number;
  name_english: string;
  name_hindi: string;
  category: string;
  unit: string;
  price: number;
  total_ordered: number;
  total_delivered: number;
  pending_quantity: number;
  total_amount: number;
  shops_count: number;
}

export interface DistributorNetworkOrderItem {
  product_id: number;
  name_english: string;
  name_hindi: string;
  category: string;
  unit: string;
  ordered_quantity: number;
  delivered_quantity: number;
  unit_price: number;
  line_total: number;
}

export interface DistributorNetworkShopOrder {
  order_id: number;
  order_number: string;
  shop_id: number;
  shop_name: string;
  shop_code: string;
  owner_name: string;
  mobile: string;
  route: string;
  area: string;
  status: OrderStatus;
  subtotal: number;
  total_amount: number;
  order_time: string;
  items: DistributorNetworkOrderItem[];
}

export interface DistributorNetworkConsolidatedItem {
  product_id: number;
  name_english: string;
  name_hindi: string;
  category: string;
  unit: string;
  price: number;
  total_ordered_qty: number;
  total_delivered_qty: number;
  total_amount: number;
  shops_count: number;
}

export interface DistributorNetworkData {
  distributor_id: number;
  business_name: string;
  owner_name: string;
  mobile: string;
  city: string;
  plan_name: string;
  subscription_status: SubscriptionStatus;
  total_orders_count: number;
  total_sales_amount: number;
  total_items_quantity: number;
  shops_ordering_count: number;
  consolidated_items: DistributorNetworkConsolidatedItem[];
  shop_orders: DistributorNetworkShopOrder[];
}

export interface SuperAdminNetworkOrdersResponse {
  date: string;
  summary: {
    total_distributors_with_orders: number;
    total_shops_ordered: number;
    total_orders: number;
    total_items_quantity: number;
    total_sales_amount: number;
  };
  distributors: DistributorNetworkData[];
}