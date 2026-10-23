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

export const VkIdLogin: React.FC<VkIdLoginProps> = ({ onSuccess, onError }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef(false);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

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
          scope: 'wall,groups,offline,photos',
        });

        const oAuth = new VKID.OAuthList();
        oAuth
          .render({
            container: containerRef.current,
            oauthList: ['vkid', 'ok_ru', 'mail_ru'],
          })
          .on(VKID.WidgetEvents.ERROR, (e: any) => {
            onError?.(String(e?.error ?? e?.error_description ?? e));
          })
          .on(VKID.OAuthListInternalEvents.LOGIN_SUCCESS, async (payload: any) => {
            const { code, device_id } = payload ?? {};
            try {
              const data = await VKID.Auth.exchangeCode(code, device_id);
              const token = data?.access_token;
              if (!token) {
                onError?.('VK ID не вернул access_token');
                return;
              }
              onSuccess(String(token), data?.user_id != null ? String(data.user_id) : undefined);
            } catch (err: any) {
              onError?.(String(err?.message ?? err));
            }
          });

        renderedRef.current = true;
        return true;
      } catch (err: any) {
        onError?.(String(err?.message ?? err));
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
    </div>
  );
};
