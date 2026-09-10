import { useEffect, useState } from "react";
import { Stack, Text } from "@mantine/core";
import { DataState } from "../../components/data-display";
import { getSourceWebhook, webhookUrl } from "./api";
import { CopyValue } from "./components";

// Retrievable, but still a credential: no query/mutation cache or browser storage.
export function SourceWebhook({ sourceId, token }: { sourceId: number; token: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    getSourceWebhook(sourceId, token).then(result => { if (current) setUrl(webhookUrl(result.webhookKey)); })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [sourceId, token, attempt]);
  return <Stack gap="xs"><Text fw={600}>Webhook URL</Text>
    {error ? <DataState state="error" title="Unable to retrieve webhook URL" onRetry={() => { setError(false); setAttempt(value => value + 1); }} /> : url ? <CopyValue value={url} name="webhook URL" secret /> : <DataState state="loading" message="Loading webhook URL…" />}
    <Text size="sm" c="dimmed">Use this URL for all external strategies assigned to this source. It remains stable unless explicitly regenerated.</Text>
  </Stack>;
}
