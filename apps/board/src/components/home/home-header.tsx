'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@moonwitness/ui/components/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@moonwitness/ui/components/sheet';
import { SoundToggle } from '@moonwitness/ui/components/audio';
import { ArrowRightIcon, MenuIcon } from '@moonwitness/ui/icons';

const homeLinks = [
  { label: 'Home', href: '#home' },
  { label: 'People', href: '#people' },
  { label: 'Knowledge', href: '#knowledge' },
  { label: 'Stories', href: '#stories' },
  { label: 'About', href: '#about' },
] as const;

export function HomeHeader() {
  const [activeSection, setActiveSection] = useState('home');

  useEffect(() => {
    let frame = 0;
    const updateActiveSection = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = [...homeLinks]
          .map(({ href }) => document.getElementById(href.slice(1)))
          .filter((section): section is HTMLElement => section !== null)
          .filter((section) => section.getBoundingClientRect().top <= 140)
          .at(-1);
        setActiveSection(active?.id ?? 'home');
      });
    };

    window.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);
    updateActiveSection();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, []);

  const renderLinks = (mobile = false) =>
    homeLinks.map((item) => {
      const link = (
        <a
          href={item.href}
          key={item.href}
          aria-current={activeSection === item.href.slice(1) ? 'location' : undefined}
        >
          {item.label}
        </a>
      );

      return mobile ? (
        <SheetClose asChild key={item.href}>
          {link}
        </SheetClose>
      ) : (
        link
      );
    });

  return (
    <header className="home-header">
      <Link href="/" className="home-mark" aria-label="MoonWitness home">
        <Image
          src="/brand/moonwitness-lockup-dark.svg"
          alt="MoonWitness"
          className="home-lockup"
          width={500}
          height={80}
          loading="eager"
        />
      </Link>
      <nav className="home-nav" aria-label="Main navigation">
        {renderLinks()}
      </nav>
      <div className="home-header-actions">
        <div className="home-desktop-sound">
          <SoundToggle />
        </div>
        <Button asChild treatment="brush" size="sm">
          <Link href="/login">
            <span className="home-header-cta-desktop">Enter the board</span>
            <span className="home-header-cta-mobile">Sign in</span>
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
        <Sheet>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="home-mobile-trigger"
              aria-label="Open site navigation"
            >
              <MenuIcon aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="home-mobile-sheet" aria-label="Site navigation">
            <SheetHeader className="home-mobile-sheet-header">
              <SheetTitle className="home-mobile-sheet-title">Explore MoonWitness</SheetTitle>
              <SheetDescription>People, knowledge, stories, and the workspace.</SheetDescription>
            </SheetHeader>
            <nav className="home-mobile-nav" aria-label="Mobile navigation">
              {renderLinks(true)}
            </nav>
            <div className="home-mobile-sheet-actions">
              <SoundToggle />
              <Button asChild treatment="brush" size="lg">
                <SheetClose asChild>
                  <Link href="/login">
                    Enter the board <ArrowRightIcon aria-hidden="true" />
                  </Link>
                </SheetClose>
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
