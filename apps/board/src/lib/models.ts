import {
  BankIcon,
  CompanyIcon,
  CreditCardIcon,
  CurrencyIcon,
  GlobeIcon,
  HashIcon,
  HomeIcon,
  KeyIcon,
  LanguageIcon,
  MapPinIcon,
  ModelIcon,
  PartnerIcon,
  SecurityIcon,
  TeamIcon,
  UsersIcon,
} from '@moonwitness/ui/icons';

const ICONS = {
  'base.partner': PartnerIcon,
  'base.company': CompanyIcon,
  'base.user': UsersIcon,
  'base.country': GlobeIcon,
  'base.country_state': MapPinIcon,
  'base.bank': BankIcon,
  'base.partner_bank': CreditCardIcon,
  'base.sequence': HashIcon,
  'base.currency': CurrencyIcon,
  'base.language': LanguageIcon,
  'organization.team': TeamIcon,
  'auth.refresh_token': KeyIcon,
};

export const DashboardIcon = HomeIcon;

export function modelIcon(model: string) {
  return (
    ICONS[model as keyof typeof ICONS] ?? (model.startsWith('auth.') ? SecurityIcon : ModelIcon)
  );
}

/** `base.partner` → `Partner`; used until the model's view title has loaded. */
export function modelLabel(model: string): string {
  const name = model.split('.').pop() ?? model;
  return name.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

/** `base.partner` → `base`; groups models by addon in the sidebar. */
export function modelAddon(model: string): string {
  return model.includes('.') ? model.split('.')[0]! : 'other';
}
