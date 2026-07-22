import type { Metadata } from "next";
import AppShell from "../components/AppShell";
import BackButton from "../components/BackButton";

export const metadata: Metadata = {
  title: "Terms & Conditions · Solens",
  description: "The terms governing your use of Solens.",
};

// Last substantive revision — update when the terms change.
const LAST_UPDATED = "July 1, 2026";

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-text-primary">
        {n}. {title}
      </h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-text-secondary">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl pb-10 pt-6">
        <BackButton fallbackHref="/" />
        <h1 className="mt-3 text-3xl font-bold">Terms &amp; Conditions</h1>
        <p className="mt-2 text-sm text-text-secondary/70">Last updated: {LAST_UPDATED}</p>

        <div className="mt-6 rounded-2xl bg-surface card-shadow p-6 sm:p-8">
          <p className="text-sm leading-relaxed text-text-secondary">
            Welcome to Solens. These Terms &amp; Conditions (the &ldquo;Terms&rdquo;) govern your access to and use
            of the Solens application, website, Telegram bot, and related services (together, the
            &ldquo;Service&rdquo;). By connecting a wallet or otherwise using the Service, you agree to these
            Terms. If you do not agree, do not use the Service.
          </p>

          <Section n={1} title="What Solens Is">
            <p>
              Solens is an AI-powered assistant for the Solana blockchain. It helps you explore tokens,
              swap assets, manage liquidity, trade prediction markets, buy and list NFTs, and track your
              portfolio through natural-language chat. Solens routes your requested actions to independent
              third-party protocols (including Jupiter, Meteora, Magic Eden, and Bags) and builds
              transactions for you to review and approve.
            </p>
            <p>
              Solens is a <span className="font-medium text-text-primary">non-custodial</span> interface. We
              never take custody of your funds. Every on-chain action is executed only after a signature is
              produced by your wallet, and you are solely responsible for reviewing and approving each
              transaction.
            </p>
          </Section>

          <Section n={2} title="Eligibility">
            <p>
              You must be at least 18 years old and legally permitted to use decentralized finance and
              prediction-market services in your jurisdiction. You are responsible for ensuring that your use
              of the Service complies with all laws that apply to you. The Service is not offered where it
              would be unlawful.
            </p>
          </Section>

          <Section n={3} title="Not Financial, Legal, or Tax Advice">
            <p>
              Solens is a tool, not an advisor. Any information, suggestion, quote, price, projected outcome,
              or AI-generated response is provided for informational purposes only and is not financial,
              investment, legal, or tax advice. AI responses can be inaccurate, incomplete, or out of date.
              Always do your own research and make your own decisions. You bear full responsibility for any
              trade or transaction you choose to make.
            </p>
          </Section>

          <Section n={4} title="Wallets & Transactions">
            <p>
              You are responsible for the security of your wallet, private keys, and recovery phrases.
              On-chain transactions are <span className="font-medium text-text-primary">irreversible</span>.
              Once you sign and broadcast a transaction, it cannot be undone, reversed, or refunded by Solens.
              Network fees, slippage, price movement between quote and execution, and failed transactions are
              inherent to blockchain activity and are your responsibility.
            </p>
          </Section>

          <Section n={5} title="Risk Disclosure">
            <p>
              Digital assets and decentralized protocols carry significant risk, including the total loss of
              funds. Risks include but are not limited to: price volatility, smart-contract vulnerabilities,
              protocol failures or exploits, loss of liquidity, oracle or keeper failures, and the resolution
              risk of prediction markets. Prediction-market positions may expire worthless. Only commit funds
              you can afford to lose.
            </p>
          </Section>

          <Section n={6} title="Third-Party Protocols">
            <p>
              The Service integrates independent third-party protocols and data providers. Solens does not
              operate, control, or guarantee those services, and is not responsible for their availability,
              accuracy, pricing, resolution of markets, or losses arising from their use. Your use of a
              third-party protocol may be subject to that protocol&rsquo;s own terms.
            </p>
          </Section>

          <Section n={7} title="Points & EP Program">
            <p>
              Solens may award Experience Points (&ldquo;EP&rdquo;) and related rewards for completing quests
              and real, verified activity. EP has{" "}
              <span className="font-medium text-text-primary">no monetary value</span>, is not a currency or
              financial instrument, cannot be redeemed for cash, and confers no ownership or equity. Quests,
              EP amounts, levels, leaderboards, and referral rewards are promotional and may be changed,
              recalculated, suspended, or discontinued at any time. We may adjust or revoke EP obtained
              through error, abuse, self-referral, botting, or any attempt to game the system.
            </p>
          </Section>

          <Section n={8} title="Acceptable Use">
            <p>You agree not to use the Service to:</p>
            <ul className="ml-5 list-disc space-y-1">
              <li>break any applicable law or regulation, or facilitate illegal activity;</li>
              <li>launder money, evade sanctions, or finance prohibited activity;</li>
              <li>manipulate markets, exploit bugs, or abuse the points/referral system;</li>
              <li>interfere with, overload, or attempt to gain unauthorized access to the Service;</li>
              <li>misrepresent your identity or use the Service on behalf of a sanctioned person.</li>
            </ul>
          </Section>

          <Section n={9} title="No Warranty">
            <p>
              The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties
              of any kind, whether express or implied, including merchantability, fitness for a particular
              purpose, and non-infringement. We do not warrant that the Service will be uninterrupted,
              error-free, secure, or that quotes and data will be accurate.
            </p>
          </Section>

          <Section n={10} title="Limitation of Liability">
            <p>
              To the maximum extent permitted by law, Solens and its contributors will not be liable for any
              indirect, incidental, special, consequential, or exemplary damages, or for any loss of funds,
              profits, tokens, or data, arising from or related to your use of the Service — including losses
              caused by transactions you approved, third-party protocols, or market outcomes.
            </p>
          </Section>

          <Section n={11} title="Changes to These Terms">
            <p>
              We may update these Terms from time to time. Material changes take effect when the updated Terms
              are posted here, and your continued use of the Service after that constitutes acceptance. Please
              review this page periodically.
            </p>
          </Section>

          <Section n={12} title="Contact">
            <p>
              Questions about these Terms or need help? Email us at{" "}
              <a
                href="mailto:ask@heyelsa.ai?subject=Solens%20Support%20Request"
                className="text-violet-300 underline underline-offset-2 hover:text-violet-200"
              >
                ask@heyelsa.ai
              </a>
              , or reach us on{" "}
              <a
                href="https://t.me/solens"
                target="_blank"
                rel="noreferrer"
                className="text-violet-300 underline underline-offset-2 hover:text-violet-200"
              >
                t.me/solens
              </a>{" "}
              or{" "}
              <a
                href="https://x.com/solens"
                target="_blank"
                rel="noreferrer"
                className="text-violet-300 underline underline-offset-2 hover:text-violet-200"
              >
                @solens
              </a>
              .
            </p>
          </Section>

          <p className="mt-8 border-t border-subtle pt-6 text-xs text-text-secondary/60">
            By using Solens you acknowledge that you have read, understood, and agree to these Terms &amp;
            Conditions.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
