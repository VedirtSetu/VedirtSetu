import React, { useState, useEffect } from 'react';
import { User, Notification } from '../types/index.ts';
import { Language, translations } from '../utils/i18n.ts';
import { PWAInstallButton } from './PWAInstallButton.tsx';
import { AppLogo } from './AppLogo.tsx';
import { api } from '../services/api.ts';
import { showBrowserNotification } from '../services/pushNotification.ts';
import { Bell, LogOut, Store, Shield, Check, Globe, Sparkles } from 'lucide-react';

interface NavbarProps {
  user: User | null;
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onLogout: () => void;
  onOpenLogin: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  user,
  lang,
  onLanguageChange,
  onLogout,
  onOpenLogin,
}) => {
  const t = translations[lang];
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const fetchNotifications = async () => {
    if (!user) return;
    try {
      const data = await api.getNotifications();
      const unreadList = data.filter((n) => n.read_status === 0);
      setNotifications(data);
      setUnreadCount(unreadList.length);

      // Trigger browser push alerts for fresh unread order alerts
      if (user.role === 'retailer' && unreadList.length > 0) {
        unreadList.forEach((n) => {
          const key = `pushed_notif_${n.id}`;
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, '1');
            showBrowserNotification(n.title, {
              body: n.message,
              tag: `app-notif-${n.id}`,
            });
          }
        });
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!user) return;

    fetchNotifications();

    // Screen lock ya tab background me hone par battery & server requests bachane ke liye visibility check
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        fetchNotifications();
      }
    }, 20000);

    // Jab user screen unlock kare ya tab par wapas aaye, turant refresh karein
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchNotifications();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user]);

  const markAllRead = async () => {
    try {
      await api.markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read_status: 1 })));
      setUnreadCount(0);
    } catch {
      // ignore
    }
  };

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-emerald-100 shadow-xs">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 h-16 flex items-center justify-between gap-2">
        {/* Brand */}
        <div className="flex items-center gap-2.5">
          <AppLogo className="w-10 h-10 shadow-sm" variant="badge" />
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-extrabold text-lg sm:text-xl text-emerald-900 tracking-tight">
                {t.appName}
              </span>
              <span className="text-[10px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                {t.appBadge}
              </span>
            </div>
            <p className="text-[10px] text-slate-500 hidden sm:block">
              {t.networkDesc}
            </p>
          </div>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* PWA Install */}
          <PWAInstallButton compact lang={lang} />

          {/* Language Switcher Button */}
          <button
            onClick={() => onLanguageChange(lang === 'hi' ? 'en' : 'hi')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-xs font-black text-emerald-900 shadow-xs transition active:scale-95"
            title={lang === 'hi' ? 'Switch to English' : 'हिन्दी में बदलें'}
          >
            <Globe className="w-3.5 h-3.5 text-emerald-700" />
            <span>{lang === 'hi' ? 'English' : 'हिन्दी'}</span>
          </button>

          {user ? (
            <>
              {/* Notification Bell */}
              <div className="relative">
                <button
                  onClick={() => setShowNotifications(!showNotifications)}
                  className="relative p-2 rounded-xl text-slate-600 hover:text-emerald-700 hover:bg-emerald-50 transition"
                  title={t.notifications}
                >
                  <Bell className="w-5 h-5" />
                  {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-red-600 text-[10px] font-bold text-white flex items-center justify-center animate-pulse">
                      {unreadCount}
                    </span>
                  )}
                </button>

                {/* Notifications Dropdown */}
                {showNotifications && (
                  <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl bg-white shadow-2xl border border-slate-200 py-3 z-50 animate-in fade-in zoom-in-95">
                    <div className="px-4 pb-2 border-b border-slate-100 flex items-center justify-between">
                      <div className="font-bold text-sm text-slate-800">
                        {t.notifications}
                      </div>
                      {unreadCount > 0 && (
                        <button
                          onClick={markAllRead}
                          className="text-xs text-emerald-600 hover:underline flex items-center gap-1 font-semibold"
                        >
                          <Check className="w-3 h-3" />
                          {t.markAllRead}
                        </button>
                      )}
                    </div>
                    <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                      {notifications.length === 0 ? (
                        <div className="py-6 text-center text-xs text-slate-400">
                          {t.noNotifications}
                        </div>
                      ) : (
                        notifications.map((n, idx) => (
                          <div
                            key={`notif-${n.id ?? idx}-${idx}`}
                            className={`p-3 text-xs transition ${
                              n.read_status === 0 ? 'bg-emerald-50/60' : 'bg-white'
                            }`}
                          >
                            <div className="font-semibold text-slate-800">{n.title}</div>
                            <div className="text-slate-600 mt-0.5">{n.message}</div>
                            <div className="text-[10px] text-slate-400 mt-1">
                              {new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* User badge */}
              <div className="flex items-center gap-2 pl-1 sm:pl-2 border-l border-slate-200">
                <div className="hidden md:block text-right">
                  <div className="text-xs font-bold text-slate-800 truncate max-w-[140px]">
                    {user.shop_name || user.name}
                  </div>
                  <div className="text-[10px] font-extrabold flex items-center gap-1 justify-end">
                    {user.role === 'superadmin' ? (
                      <span className="text-purple-700 flex items-center gap-1">
                        <Shield className="w-2.5 h-2.5 text-purple-600" />
                        <span>{lang === 'hi' ? 'कंपनी सुपर एडमिन' : 'Platform Super Admin'}</span>
                      </span>
                    ) : user.role === 'admin' ? (
                      <span className="text-emerald-700 flex items-center gap-1">
                        <Shield className="w-2.5 h-2.5" />
                        <span>{t.distributorAdmin}</span>
                      </span>
                    ) : (
                      <span className="text-emerald-700 flex items-center gap-1">
                        <Store className="w-2.5 h-2.5" />
                        <span>{user.shop_code}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Logout Button */}
                <button
                  onClick={onLogout}
                  className="p-2 rounded-xl text-slate-500 hover:text-red-600 hover:bg-red-50 transition"
                  title={t.logout}
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={onOpenLogin}
              className="px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs sm:text-sm shadow-xs transition"
            >
              {t.loginTitle}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};