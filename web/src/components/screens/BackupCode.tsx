"use client";

import { useEffect, useState } from "react";
import { BACKUP_CODE_SYNCED_TEXT, BACKUP_CODE_TEXT, type AutumnClient } from "@/lib/autumn";
import { errorText } from "@/lib/useAutumn";
import { Button, CopyButton, Panel, ScreenHead, Spinner } from "../ui";
import { Icon } from "../icons";

/**
 * "Save your backup code": shown right after creating every wallet, and again from the Wallet panel. For a
 * device-bound passkey it is the only way back in after the browser's data is cleared; for a synced one a second way.
 */
export function BackupCode({ client, onDone, onBack, deviceBound = true }: { client: AutumnClient; onDone: () => void; onBack?: () => void; deviceBound?: boolean }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    client
      .getBackupCode()
      .then((c) => alive && setCode(c))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [client, attempt]);

  return (
    <div className="screen backup">
      <ScreenHead title="Save your backup code" onBack={onBack} />
      <Panel title="Your backup code" icon="passkey">
        <p>{deviceBound ? BACKUP_CODE_TEXT : BACKUP_CODE_SYNCED_TEXT}</p>
        {code ? (
          <>
            <p className="codebox num" aria-label="Your backup code">
              {code}
            </p>
            <div className="row">
              <CopyButton text={code} label="Copy code" what="backup code" />
            </div>
          </>
        ) : error ? (
          <div className="row">
            <p className="error-text" role="alert">
              {error}
            </p>
            <Button variant="plain" className="btn--small" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <p className="waiting" role="status">
            <Spinner /> Preparing your backup code…
          </p>
        )}
        <p className="with-icon">
          <Icon name="send" />
          <span>Keep small amounts here. You can send your funds out at any time.</span>
        </p>
      </Panel>
      <div className="screen__actions">
        <Button block onClick={onDone} disabled={!code}>
          I saved it
        </Button>
      </div>
    </div>
  );
}
