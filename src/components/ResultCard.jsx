import { Copy, Check, ExternalLink } from 'lucide-react';
import { useState } from 'react';

const formatDisplayMap = {
  'application/rss+xml': 'RSS',
  'application/atom+xml': 'Atom',
  'application/json': 'JSON',
  'text/xml': 'XML'
};

const getFormatLabel = (type) => {
  if (!type) return 'RSS';
  const label = formatDisplayMap[type.toLowerCase()] || type;
  if (label.includes('atom')) return 'Atom';
  if (label.includes('json')) return 'JSON';
  return 'RSS';
};

const getFormatClass = (label) => {
  if (label === 'Atom') return 'atom';
  if (label === 'JSON') return 'json';
  return 'rss';
};

export default function ResultCard({ feed, showToast, index = 0 }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(feed.url);
    setCopied(true);
    
    showToast('URL copiada al portapapeles');
    
    setTimeout(() => {
      setCopied(false);
    }, 2500);
  };

  const formatLabel = getFormatLabel(feed.type);
  const typeClass = getFormatClass(formatLabel);
  const staggerClass = `stagger-${(index % 10) + 1}`;

  return (
    <div className={`result-card ${staggerClass}`}>
      <div className="result-info">
        <span className={`result-type ${typeClass}`}>{formatLabel}</span>
        <a 
          href={feed.url} 
          target="_blank" 
          rel="noopener noreferrer" 
          className="result-url"
          title={feed.url}
          style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          {feed.url}
          <ExternalLink size={14} style={{ opacity: 0.5 }} />
        </a>
        {feed.title && (
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Título: {feed.title}
          </span>
        )}
      </div>
      
      <button 
        className={`copy-btn ${copied ? 'copied' : ''}`}
        onClick={handleCopy}
        title="Copiar URL"
        aria-label="Copiar URL al portapapeles"
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}
      </button>
    </div>
  );
}
