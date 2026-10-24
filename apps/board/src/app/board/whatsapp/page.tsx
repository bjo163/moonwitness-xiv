import { WhatsappPage } from '../../../board-pages/whatsapp-page';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'WhatsApp | Board',
  robots: { index: false, follow: false },
};

export default function WhatsappRoute() {
  return <WhatsappPage />;
}
