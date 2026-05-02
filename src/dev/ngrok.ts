import 'dotenv/config';
import ngrok from '@ngrok/ngrok';

const port = Number(process.env.PORT ?? 3000);
const authToken = process.env.NGROK_AUTHTOKEN ?? '';
const domain = process.env.NGROK_DOMAIN;

if (!authToken) {
  throw new Error('NGROK_AUTHTOKEN is required to start the dev tunnel.');
}

async function main() {
  const forwardOptions = domain
    ? {
        addr: port,
        authtoken: authToken,
        domain,
      }
    : {
        addr: port,
        authtoken: authToken,
      };

  const listener = await ngrok.forward(forwardOptions);

  console.log(`ngrok tunnel running: ${listener.url()}`);
  console.log(`Forwarding to local backend: http://localhost:${port}`);

  process.stdin.resume();
}

main().catch((error) => {
  console.error('Failed to start ngrok tunnel:', error);
  process.exit(1);
});