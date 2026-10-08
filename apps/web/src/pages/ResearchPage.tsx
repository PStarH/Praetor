/**
 * ResearchPage — 研究参与边界说明页。
 *
 * 展示 Praetor 在 alpha 研究预览阶段如何处理研究参与、同意与数据边界，
 * 内容与根目录 PRIVACY.md 的 "Research participation" 一节保持一致。
 */
import { ClipboardCheck } from 'lucide-react';
import { t } from '../i18n';

const SECTIONS = [
  { key: 'consent' },
  { key: 'used' },
  { key: 'withdraw' },
  { key: 'feedback' },
] as const;

export function ResearchPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">{t('research.sectionLabel')}</div>
          <h1>
            <ClipboardCheck size={20} /> {t('research.title')}
          </h1>
        </div>
        <p className="page-desc">{t('research.desc')}</p>
      </div>

      {SECTIONS.map(({ key }) => (
        <div key={key} className="card" style={{ marginBottom: 16 }}>
          <h3>{t(`research.${key}.title`)}</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
            {t(`research.${key}.body`)}
          </p>
        </div>
      ))}

      <div className="card">
        <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          <a
            href="https://github.com/PStarH/Praetor/blob/master/PRIVACY.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('research.privacy.link')}
          </a>
        </p>
      </div>
    </div>
  );
}
