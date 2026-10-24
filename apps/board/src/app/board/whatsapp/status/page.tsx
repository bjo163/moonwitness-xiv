import { WhatsAppStatusPage } from '../../../../board-pages/whatsapp-status-page';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'WhatsApp Status | Board',
  robots: { index: false, follow: false },
};

export default function WhatsAppStatusRoute() {
  return <WhatsAppStatusPage />;
}
