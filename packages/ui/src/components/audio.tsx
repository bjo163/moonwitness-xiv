'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Button } from './button.js';
import { VolumeIcon } from '../icons/volume.js';
import { VolumeOffIcon } from '../icons/volume-off.js';
import {
  persistSoundPreference,
  playCatalogSound,
  readSoundPreference,
  type SfxName,
} from '../lib/audio-runtime.js';

export type { SfxName } from '../lib/audio-runtime.js';

type SfxContextValue = {
  enabled: boolean;
  ready: boolean;
  setEnabled: (value: boolean) => void;
  play: (name: SfxName) => void;
};
const SfxContext = createContext<SfxContextValue | null>(null);

export function SoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setEnabledState(readSoundPreference(window.localStorage));
    } catch {
      setEnabledState(false);
    }
    const activate = () => setReady(true);
    window.addEventListener('pointerdown', activate, { once: true, passive: true });
    window.addEventListener('keydown', activate, { once: true });
    return () => {
      window.removeEventListener('pointerdown', activate);
      window.removeEventListener('keydown', activate);
    };
  }, []);
  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    try {
      persistSoundPreference(window.localStorage, value);
    } catch {
      /* Storage may be unavailable. */
    }
  }, []);
  const play = useCallback(
    (name: SfxName) => {
      if (!enabled || !ready || typeof window === 'undefined') return;
      playCatalogSound(name, enabled, ready, (source) => new Audio(source));
    },
    [enabled, ready]
  );
  const value = useMemo(
    () => ({ enabled, ready, setEnabled, play }),
    [enabled, ready, setEnabled, play]
  );
  return <SfxContext.Provider value={value}>{children}</SfxContext.Provider>;
}

export function useSfx() {
  const value = useContext(SfxContext);
  if (!value) throw new Error('useSfx must be used within SoundProvider.');
  return value;
}

export function SoundToggle() {
  const { enabled, setEnabled } = useSfx();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-10 w-10 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3"
      aria-pressed={enabled}
      aria-label={enabled ? 'Mute interface sounds' : 'Enable interface sounds'}
      onClick={() => setEnabled(!enabled)}
    >
      {enabled ? (
        <>
          <VolumeIcon className="size-4 sm:hidden" />
          <span className="hidden sm:inline">Sound on</span>
        </>
      ) : (
        <>
          <VolumeOffIcon className="size-4 sm:hidden" />
          <span className="hidden sm:inline">Sound off</span>
        </>
      )}
    </Button>
  );
}
