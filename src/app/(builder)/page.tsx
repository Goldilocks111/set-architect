import type { Metadata } from 'next';
import { Barlow, Barlow_Semi_Condensed } from 'next/font/google';
import Builder from '@/components/Builder';
import { isDemoMode } from '@/lib/demo';

const display = Barlow_Semi_Condensed({
  subsets: ['latin', 'latin-ext'],
  weight: ['500', '600'],
  variable: '--font-display',
});

const body = Barlow({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
});

export const metadata: Metadata = {
  title: 'Set Architect',
  description: 'Build a DJ set track by track against an energy arc, with key, tempo and real-set suggestions.',
};

export default function BuilderPage() {
  return (
    <div className={`${display.variable} ${body.variable} flex flex-1 flex-col`}>
      <Builder demo={isDemoMode()} getSongBpmConfigured={Boolean(process.env.GETSONGBPM_API_KEY)} />
    </div>
  );
}
