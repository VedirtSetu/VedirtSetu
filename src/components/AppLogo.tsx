import React from 'react';

interface AppLogoProps {
  className?: string;
  size?: number | string;
  variant?: 'icon' | 'full' | 'badge';
  showText?: boolean;
}

export const AppLogo: React.FC<AppLogoProps> = ({
  className = 'w-10 h-10',
  size,
  variant = 'badge',
  showText = false,
}) => {
  const uid = React.useId().replace(/:/g, '');

  const SvgGraphic = (
    <g transform="translate(0, 0)">
      <defs>
        <linearGradient id={`grad-left-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#006636" />
          <stop offset="50%" stopColor="#008846" />
          <stop offset="100%" stopColor="#059A4E" />
        </linearGradient>
        <linearGradient id={`grad-fold-${uid}`} x1="0%" y1="0%" x2="70%" y2="100%">
          <stop offset="0%" stopColor="#014A26" />
          <stop offset="100%" stopColor="#00351B" />
        </linearGradient>
        <linearGradient id={`grad-right-${uid}`} x1="0%" y1="100%" x2="80%" y2="0%">
          <stop offset="0%" stopColor="#028A44" />
          <stop offset="50%" stopColor="#16A34A" />
          <stop offset="85%" stopColor="#22C55E" />
          <stop offset="100%" stopColor="#3CD070" />
        </linearGradient>
        <linearGradient id={`grad-base-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#007A3E" />
          <stop offset="100%" stopColor="#1DBB59" />
        </linearGradient>
      </defs>

      {/* Cart Handle & Left Stem of V */}
      <path
        d="M 112 165 C 104 165 100 171 100 177 C 100 183 104 188 112 188 L 155 188 C 182 188 206 216 226 264 C 244 306 264 322 284 316 C 272 322 254 322 238 312 C 214 296 194 256 174 212 C 160 180 138 166 112 165 Z"
        fill={`url(#grad-left-${uid})`}
      />

      {/* 3D Ribbon Fold Shadow */}
      <path
        d="M 226 264 C 238 290 252 308 272 316 C 260 318 246 312 236 298 C 226 284 218 266 210 248 C 216 254 221 259 226 264 Z"
        fill={`url(#grad-fold-${uid})`}
        opacity="0.9"
      />

      {/* Right Wing & Arrow */}
      <path
        d="M 238 312 C 256 322 280 316 296 292 L 368 184 L 326 172 L 404 124 L 410 208 L 376 196 L 294 300 C 276 324 252 324 238 312 Z"
        fill={`url(#grad-right-${uid})`}
      />

      {/* Cart Base Tray */}
      <rect x="176" y="324" width="134" height="24" rx="12" fill={`url(#grad-base-${uid})`} />

      {/* Cart Wheels */}
      <circle cx="204" cy="374" r="19" fill="#007A3E" />
      <circle cx="286" cy="374" r="19" fill="#007A3E" />
    </g>
  );

  return (
    <div
      className={`inline-flex items-center justify-center shrink-0 select-none ${className}`}
      style={size ? { width: size, height: size } : undefined}
    >
      <svg viewBox="0 0 512 512" fill="none" className="w-full h-full drop-shadow-xs">
        <rect x="16" y="16" width="480" height="480" rx="116" fill="#FFFFFF" stroke="#E2E8F0" strokeWidth="3" />
        {SvgGraphic}
      </svg>
    </div>
  );
};

export default AppLogo;