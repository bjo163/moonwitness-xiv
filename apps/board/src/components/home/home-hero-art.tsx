'use client';

import { useState } from 'react';

export function HomeHeroArt() {
  const [failed, setFailed] = useState(false);

  return (
    <div className="home-hero-art" aria-hidden="true">
      {failed ? (
        <div className="home-hero-fallback" data-testid="home-hero-fallback" />
      ) : (
        <picture>
          <source media="(max-width: 600px)" srcSet="/illustrations/home-hero-mobile.webp" />
          <img
            className="home-hero-art-image"
            src="/illustrations/home-hero-desktop.webp"
            alt=""
            fetchPriority="high"
            onError={() => setFailed(true)}
          />
        </picture>
      )}
    </div>
  );
}
