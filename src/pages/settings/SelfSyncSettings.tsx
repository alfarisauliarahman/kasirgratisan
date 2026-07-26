import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronLeft,
  RefreshCw,
  Eye,
  EyeOff,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Smartphone,
  Wifi,
  RotateCcw,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import LockedPage from '@/components/LockedPage';
import { useTranslation } from 'react-i18next';
import {
  getConfig,
  setConfig,
  getDeviceId,
  getLastSyncAt,
  resetCursor,
  normalizeUrl,
} from '@/lib/selfsync/config';

const NUMBER_LOCALES: Record<string, string> = { id: 'id-ID', en: 'en-US', ms: 'ms-MY' };

/** Berapa lama kita menunggu server sebelum menyerah saat tes koneksi. */
const TEST_TIMEOUT_MS = 12000;

type TestResult = { ok: boolean; message: string } | null;
type SyncResult = { ok: boolean; message: string } | null;

export default function SelfSyncSettings() {
  const { can } = useAuth();
  const { t, i18n } = useTranslation('settings');
  const numberLocale = NUMBER_LOCALES[i18n.language] ?? 'id-ID';

  // Yang tersimpan di perangkat (sumber kebenaran), dan yang sedang diketik.
  const [saved, setSaved] = useState(() => getConfig());
  const [url, setUrl] = useState(saved.url);
  const [secret, setSecret] = useState(saved.secret);
  const [showSecret, setShowSecret] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult>(null);
  // Dibaca dari state supaya waktunya ikut menyegar setelah sync manual,
  // bukan hanya saat halaman dibuka ulang.
  const [lastSyncAt, setLastSyncAt] = useState(() => getLastSyncAt());

  const deviceId = getDeviceId();

  /**
   * Jalankan sync sekarang dan tunjukkan hasilnya apa adanya.
   *
   * Ini juga alat diagnosa: tanpa ini, "belum muncul di HP lain" tidak bisa
   * dibedakan dari "sync-nya memang tidak jalan".
   */
  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const { syncNow } = await import('@/lib/selfsync/scheduler');
      const r = await syncNow();

      if (r.skipped === 'not-configured') {
        setSyncResult({ ok: false, message: t('selfSync.sync.notConfigured') });
      } else if (!r.ok) {
        setSyncResult({ ok: false, message: r.error ?? t('selfSync.sync.failed') });
      } else {
        setSyncResult({
          ok: true,
          message: t('selfSync.sync.done', { sent: r.pushed, received: r.applied }),
        });
        setLastSyncAt(getLastSyncAt());
      }
    } catch (err) {
      setSyncResult({
        ok: false,
        message: err instanceof Error ? err.message : t('selfSync.sync.failed'),
      });
    } finally {
      setSyncing(false);
    }
  };

  if (!can('manage_backup')) {
    return (
      <LockedPage
        title={t('selfSync.locked.title')}
        permissionLabel={t('selfSync.locked.permissionLabel')}
      />
    );
  }

  const dirty = normalizeUrl(url) !== saved.url || secret.trim() !== saved.secret;
  const hasSavedConfig = saved.url.length > 0 && saved.secret.length > 0;
  /** Tombol simpan hanya mati kalau memang sudah ada isian tersimpan dan tidak diubah. */
  const upToDate = !dirty && hasSavedConfig;

  const handleSave = () => {
    const nextUrl = normalizeUrl(url);
    if (!nextUrl) {
      toast.error(t('selfSync.toast.urlRequired'));
      return;
    }
    if (!secret.trim()) {
      toast.error(t('selfSync.toast.secretRequired'));
      return;
    }
    setConfig({ url: nextUrl, secret });
    const next = getConfig();
    setSaved(next);
    setUrl(next.url);
    setSecret(next.secret);
    setTestResult(null);
    toast.success(t('selfSync.toast.saved'));
  };

  const handleToggle = (enabled: boolean) => {
    setConfig({ enabled });
    setSaved(getConfig());
    toast.success(enabled ? t('selfSync.toast.enabled') : t('selfSync.toast.disabled'));
  };

  /**
   * Tes koneksi hanya menyentuh `/api/health`, yang tidak butuh autentikasi.
   * Kunci rahasia sengaja TIDAK ikut dikirim dan tidak pernah masuk ke pesan
   * error, supaya tidak bocor lewat log jaringan atau tangkapan layar.
   */
  const handleTest = async () => {
    const candidate = normalizeUrl(url);
    if (!candidate) {
      setTestResult({ ok: false, message: t('selfSync.test.emptyUrl') });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      setTestResult({ ok: false, message: t('selfSync.test.invalidUrl') });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setTestResult({ ok: false, message: t('selfSync.test.invalidUrl') });
      return;
    }

    setTesting(true);
    setTestResult(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${candidate}/api/health`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (res.ok) {
        setTestResult({ ok: true, message: t('selfSync.test.ok') });
      } else {
        setTestResult({ ok: false, message: t('selfSync.test.badStatus', { status: res.status }) });
      }
    } catch {
      // Jaringan mati, DNS salah, HTTPS ditolak, atau kelamaan menunggu.
      setTestResult({ ok: false, message: t('selfSync.test.unreachable') });
    } finally {
      window.clearTimeout(timer);
      setTesting(false);
    }
  };

  const handleResetCursor = () => {
    resetCursor();
    setResetOpen(false);
    toast.success(t('selfSync.toast.cursorReset'));
  };

  const statusOn = saved.enabled && hasSavedConfig;

  return (
    <div className="px-4 pt-6 pb-20 space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/settings">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ChevronLeft className="w-4 h-4" />
          </Button>
        </Link>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <RefreshCw className="w-5 h-5 text-primary" />
          {t('selfSync.title')}
        </h1>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">{t('selfSync.intro')}</p>

      {/* Status */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                statusOn ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
              }`}
            >
              <RefreshCw className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-semibold">{t('selfSync.status.title')}</p>
                <span
                  className={`text-[9px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 ${
                    statusOn ? 'bg-success text-white' : 'bg-muted-foreground/70 text-white'
                  }`}
                >
                  {statusOn ? t('selfSync.status.on') : t('selfSync.status.off')}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                {lastSyncAt
                  ? t('selfSync.status.lastSync', { time: lastSyncAt.toLocaleString(numberLocale) })
                  : t('selfSync.status.neverSynced')}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 p-3">
            <div className="min-w-0 pr-1">
              <Label className="text-sm">{t('selfSync.toggle.label')}</Label>
              <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                {hasSavedConfig ? t('selfSync.toggle.description') : t('selfSync.toggle.needsConfig')}
              </p>
            </div>
            <Switch
              checked={saved.enabled}
              disabled={!hasSavedConfig}
              onCheckedChange={handleToggle}
              aria-label={t('selfSync.toggle.label')}
            />
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={handleSyncNow}
            disabled={syncing || !hasSavedConfig}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? t('selfSync.sync.running') : t('selfSync.sync.button')}
          </Button>

          {syncResult && (
            <div
              className={`rounded-xl p-3 text-[11px] leading-snug ${
                syncResult.ok
                  ? 'bg-success/10 text-success'
                  : 'bg-destructive/10 text-destructive'
              }`}
            >
              {syncResult.message}
            </div>
          )}

          <div className="flex items-start gap-2 text-[10px] text-muted-foreground">
            <Smartphone className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {t('selfSync.status.deviceId')}{' '}
              <span className="font-mono font-semibold text-foreground">{deviceId.slice(0, 8)}</span>
              {' · '}
              {t('selfSync.status.deviceIdHint')}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Alamat server & kunci */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 space-y-4">
          <p className="text-sm font-semibold">{t('selfSync.form.title')}</p>

          <div className="space-y-1.5">
            <Label htmlFor="selfsync-url">{t('selfSync.form.urlLabel')}</Label>
            <Input
              id="selfsync-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setTestResult(null);
              }}
              placeholder={t('selfSync.form.urlPlaceholder')}
              className="h-11 font-mono text-sm"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="text-[10px] text-muted-foreground">{t('selfSync.form.urlHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="selfsync-secret">{t('selfSync.form.secretLabel')}</Label>
            <div className="relative">
              <Input
                id="selfsync-secret"
                type={showSecret ? 'text' : 'password'}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={t('selfSync.form.secretPlaceholder')}
                className="h-11 pr-12 font-mono text-sm"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
                aria-label={showSecret ? t('selfSync.form.hideSecret') : t('selfSync.form.showSecret')}
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">{t('selfSync.form.secretHint')}</p>
          </div>

          {/* Peringatan keamanan kunci */}
          <div className="rounded-xl bg-warning/10 border border-warning/30 p-3 space-y-1.5">
            <p className="text-xs font-semibold flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-warning shrink-0" />
              {t('selfSync.warning.title')}
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t('selfSync.warning.sameSecret')}
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t('selfSync.warning.keepPrivate')}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Button className="w-full h-11 font-semibold" disabled={upToDate} onClick={handleSave}>
              {upToDate ? t('selfSync.form.savedAlready') : t('selfSync.form.save')}
            </Button>
            <Button
              variant="outline"
              className="w-full h-11 gap-2"
              disabled={testing}
              onClick={handleTest}
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
              {testing ? t('selfSync.test.testing') : t('selfSync.test.button')}
            </Button>
          </div>

          {testResult && (
            <div
              className={`flex items-start gap-2 rounded-xl p-3 text-[11px] leading-relaxed ${
                testResult.ok
                  ? 'bg-success/10 ring-1 ring-success/20'
                  : 'bg-destructive/10 ring-1 ring-destructive/20'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-px" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-px" />
              )}
              <span className="text-foreground">{testResult.message}</span>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground">{t('selfSync.test.note')}</p>
        </CardContent>
      </Card>

      {/* Lanjutan */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 space-y-3">
          <p className="text-sm font-semibold">{t('selfSync.advanced.title')}</p>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">{t('selfSync.advanced.resetTitle')}</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t('selfSync.advanced.resetDescription')}
            </p>
          </div>
          <Button variant="outline" className="w-full h-10 gap-2 text-xs" onClick={() => setResetOpen(true)}>
            <RotateCcw className="w-3.5 h-3.5" />
            {t('selfSync.advanced.resetButton')}
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent className="max-w-[90vw] rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('selfSync.advanced.dialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('selfSync.advanced.dialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleResetCursor}>
              {t('selfSync.advanced.dialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
