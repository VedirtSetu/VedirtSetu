import React, { useState, useEffect } from 'react';
import { User } from './types/index.ts';
import { Language } from './utils/i18n.ts';
import { api, getStoredToken, setStoredToken } from './services/api.ts';
import { Navbar } from './components/Navbar.tsx';
import { LoginModal } from './components/LoginModal.tsx';
import { RetailerDashboard } from './components/retailer/RetailerDashboard.tsx';
import { AdminDashboard } from './components/admin/AdminDashboard.tsx';
import { SuperAdminDashboard } from './components/superadmin/SuperAdminDashboard.tsx';
import { OfflineIndicator } from './components/OfflineIndicator.tsx';
import { AppLogo } from './components/AppLogo.tsx';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode; lang: Language },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode; lang: Language }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Unhandled UI Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[400px] flex items-center justify-center p-6 text-center">
          <div className="bg-white p-8 rounded-3xl border border-rose-200 shadow-xl max-w-md w-full">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center text-2xl font-bold mb-4">
              ⚠️
            </div>
            <h2 className="text-xl font-black text-slate-900 mb-2">
              {this.props.lang === 'hi' ? 'कुछ अप्रत्याशित त्रुटि आई' : 'Something went wrong'}
            </h2>
            <p className="text-xs text-slate-500 font-medium mb-6">
              {this.state.error?.message ||
                (this.props.lang === 'hi' ? 'डैशबोर्ड लोड करते समय समस्या हुई।' : 'Error loading dashboard view.')}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="w-full py-3 rounded-2xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm transition shadow-md"
            >
              {this.props.lang === 'hi' ? 'पेज पुनः लोड करें' : 'Reload Page'}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [impersonatingUser, setImpersonatingUser] = useState<User | null>(null);
  const [lang, setLang] = useState<Language>(() => {
    return (localStorage.getItem('doodhsetu_lang') as Language) || 'en';
  });
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loadingAuth, setLoadingAuth] = useState(true);

  const handleLanguageChange = (newLang: Language) => {
    setLang(newLang);
    localStorage.setItem('doodhsetu_lang', newLang);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('superadmin_original_token');
    sessionStorage.removeItem('impersonating_distributor_token');
    sessionStorage.removeItem('impersonating_distributor_user');
    setStoredToken(null);
    setImpersonatingUser(null);
    setUser(null);
    setShowLoginModal(true);
  };

  const handleInspectDistributor = (distUser: User, token?: string) => {
    const currentToken = getStoredToken();
    if (currentToken && !sessionStorage.getItem('superadmin_original_token')) {
      sessionStorage.setItem('superadmin_original_token', currentToken);
    }
    if (token) {
      sessionStorage.setItem('impersonating_distributor_token', token);
      setStoredToken(token);
    }
    sessionStorage.setItem('impersonating_distributor_user', JSON.stringify(distUser));
    setImpersonatingUser(distUser);
    setUser(distUser);
  };

  const handleReturnToSuperAdmin = () => {
    const originalToken = sessionStorage.getItem('superadmin_original_token');
    sessionStorage.removeItem('superadmin_original_token');
    sessionStorage.removeItem('impersonating_distributor_token');
    sessionStorage.removeItem('impersonating_distributor_user');
    if (originalToken) {
      setStoredToken(originalToken);
    }
    setImpersonatingUser(null);
    setLoadingAuth(true);
    api.getMe()
      .then((adminUser) => {
        setUser(adminUser);
      })
      .catch(() => {
        handleLogout();
      })
      .finally(() => {
        setLoadingAuth(false);
      });
  };

  useEffect(() => {
    const handleAuthLogoutEvent = () => {
      setUser(null);
      setImpersonatingUser(null);
      setShowLoginModal(true);
    };

    // Browser ke alag-alag tabs ke beech login/logout sync rakhne ke liye listener
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'doodhsetu_token') {
        if (!e.newValue) {
          // Doosre tab me logout hua - is tab ko bhi safely logout karein
          setUser(null);
          setImpersonatingUser(null);
          sessionStorage.removeItem('superadmin_original_token');
          sessionStorage.removeItem('impersonating_distributor_token');
          sessionStorage.removeItem('impersonating_distributor_user');
          setShowLoginModal(true);
        } else if (!sessionStorage.getItem('superadmin_original_token')) {
          // Doosre tab me login/token refresh hua aur ye tab kisi distributor inspection me nahi hai
          api
            .getMe()
            .then((userData) => {
              setUser(userData);
              setShowLoginModal(false);
            })
            .catch(() => {});
        }
      }
    };

    window.addEventListener('doodhsetu_auth_logout', handleAuthLogoutEvent);
    window.addEventListener('storage', handleStorageChange);

    // Agar SuperAdmin distributor inspect karte waqt page refresh kare, to inspection state retain karein
    const savedDistUser = sessionStorage.getItem('impersonating_distributor_user');
    if (savedDistUser && sessionStorage.getItem('superadmin_original_token')) {
      try {
        setImpersonatingUser(JSON.parse(savedDistUser));
      } catch {
        sessionStorage.removeItem('impersonating_distributor_user');
      }
    }

    const token = getStoredToken();
    if (token) {
      api
        .getMe()
        .then((userData) => {
          setUser(userData);
          setShowLoginModal(false);
        })
        .catch(() => {
          // Agar active token fail ho par tab ke paas original SuperAdmin token ho, to safely restore karein
          const originalAdminToken = sessionStorage.getItem('superadmin_original_token');
          if (originalAdminToken) {
            setStoredToken(originalAdminToken);
            sessionStorage.removeItem('superadmin_original_token');
            sessionStorage.removeItem('impersonating_distributor_token');
            sessionStorage.removeItem('impersonating_distributor_user');
            setImpersonatingUser(null);
            api
              .getMe()
              .then((adminData) => {
                setUser(adminData);
                setShowLoginModal(false);
              })
              .catch(() => {
                setStoredToken(null);
                setUser(null);
                setShowLoginModal(true);
              });
          } else {
            setStoredToken(null);
            setUser(null);
            setShowLoginModal(true);
          }
        })
        .finally(() => {
          setLoadingAuth(false);
        });
    } else {
      setLoadingAuth(false);
      setShowLoginModal(true);
    }

    return () => {
      window.removeEventListener('doodhsetu_auth_logout', handleAuthLogoutEvent);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  if (loadingAuth) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <AppLogo className="w-16 h-16 mx-auto animate-pulse" variant="badge" />
          <p className="text-xs font-bold text-slate-500">
            {lang === 'hi' ? 'वेदिरतसेतु लोड हो रहा है...' : 'VedirtSetu loading...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50/70 text-slate-900 font-sans selection:bg-emerald-100 selection:text-emerald-900">
      <Navbar
        user={user}
        lang={lang}
        onLanguageChange={handleLanguageChange}
        onLogout={handleLogout}
        onOpenLogin={() => setShowLoginModal(true)}
      />

      {/* Impersonation top notification banner */}
      {impersonatingUser && (
        <div className="bg-amber-400 text-slate-950 px-4 py-2.5 text-xs font-black flex flex-wrap items-center justify-between gap-2 shadow-md sticky top-0 z-40 border-b border-amber-500">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded-md bg-black/10 text-sm">👁️</span>
            <span>
              {lang === 'hi'
                ? `सुपर एडमिन निरीक्षण मोड: आप "${impersonatingUser.business_name || impersonatingUser.name}" का लाइव वितरक पोर्टल देख रहे हैं`
                : `Super Admin Mode: Inspecting "${impersonatingUser.business_name || impersonatingUser.name}" Live Distributor Workspace`}
            </span>
          </div>
          <button
            onClick={handleReturnToSuperAdmin}
            className="px-3.5 py-1.5 bg-slate-950 hover:bg-slate-800 text-white rounded-xl text-xs font-black transition active:scale-95 shadow-xs"
          >
            {lang === 'hi' ? '← सुपर एडमिन डैशबोर्ड पर लौटें' : '← Return to Super Admin'}
          </button>
        </div>
      )}

      <main className="pb-12">
        {user ? (
          <ErrorBoundary lang={lang}>
            {impersonatingUser ? (
              <AdminDashboard user={impersonatingUser} lang={lang} />
            ) : user.role === 'superadmin' ? (
              <SuperAdminDashboard
                user={user}
                lang={lang}
                onInspectDistributor={handleInspectDistributor}
              />
            ) : user.role === 'admin' ? (
              <AdminDashboard user={user} lang={lang} />
            ) : (
              <RetailerDashboard user={user} lang={lang} />
            )}
          </ErrorBoundary>
        ) : null}
      </main>

      {/* Login Modal */}
      {showLoginModal && (
        <LoginModal
          lang={lang}
          onSuccess={(loggedInUser) => {
            setUser(loggedInUser);
            setShowLoginModal(false);
          }}
        />
      )}

      {/* Offline Connectivity Banner */}
      <OfflineIndicator lang={lang} />
    </div>
  );
}