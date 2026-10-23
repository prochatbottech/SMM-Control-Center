import React, { useEffect, useRef } from 'react';

declare global {
  interface Window {
    VKIDSDK?: any;
  }
}

interface VkIdLoginProps {
  onSuccess: (accessToken: string, userId?: string) => void;
  onError?: (message: string) => void;
}

// VK ID application id (VK ID app with OK/Mail.ru login enabled).
const VK_ID_APP = 54847796;

function describeError(e: any): string {
  if (e == null) return 'неизвестная ошибка';
  if (typeof e === 'string') return e;
  const anyE = e as any;
  const direct = anyE.error_description || anyE.message || anyE.error || anyE.reason;
  if (direct && typeof direct === 'string') return direct;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export const VkIdLogin: React.FC<VkIdLoginProps> = ({ onSuccess, onError }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef(false);
  const [status, setStatus] = React.useState<string>('');

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    const fail = (e: any) => {
      const msg = describeError(e);
      setStatus(`Ошибка VK ID: ${msg}`);
      onError?.(msg);
    };

    const tryRender = (): boolean => {
      const VKID = window.VKIDSDK;
      if (!VKID) return false;
      if (renderedRef.current || !containerRef.current) return true;

      try {
        VKID.Config.init({
          app: VK_ID_APP,
          redirectUrl: 'https://oauth.vk.com/blank.html',
          responseMode: VKID.ConfigResponseMode.Callback,
          source: VKID.ConfigSource.LOWCODE,
          scope: 'wall,groups,photos',
        });

        const oAuth = new VKID.OAuthList();
        oAuth
          .render({
            container: containerRef.current,
            oauthList: ['vkid', 'ok_ru', 'mail_ru'],
          })
          .on(VKID.WidgetEvents.ERROR, (e: any) => fail(e))
          .on(VKID.OAuthListInternalEvents.LOGIN_SUCCESS, async (payload: any) => {
            const { code, device_id } = payload ?? {};
            try {
              const data = await VKID.Auth.exchangeCode(code, device_id);
              const token = data?.access_token;
              if (!token) {
                fail({ error_description: 'VK ID не вернул access_token', data });
                return;
              }
              setStatus('');
              onSuccess(String(token), data?.user_id != null ? String(data.user_id) : undefined);
            } catch (err: any) {
              fail(err);
            }
          });

        renderedRef.current = true;
        return true;
      } catch (err: any) {
        fail(err);
        return true;
      }
    };

    if (!tryRender()) {
      // Poll until the CDN script has loaded the global SDK.
      interval = setInterval(() => {
        if (tryRender() && interval) {
          clearInterval(interval);
          interval = null;
        }
      }, 300);
      // Give up after ~12s if the SDK never loads.
      setTimeout(() => {
        if (!renderedRef.current) {
          const m = 'SDK VK ID не загрузился (нет доступа к unpkg / заблокирован)';
          setStatus(m);
          onError?.(m);
        }
      }, 12000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [onSuccess, onError]);

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Войдите через VK / OK / Mail.ru, чтобы выбрать сообщество для публикации:
      </p>
      <div ref={containerRef} className="min-h-[48px]" />
      {status && (
        <p className="text-xs text-rose-600 dark:text-rose-400 break-words">{status}</p>
      )}
    </div>
  );
};
