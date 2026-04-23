export class AlpacaApiError extends Error {
  statusCode: number;
  responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    super(`Alpaca request failed (${statusCode}): ${responseBody}`);
    this.name = 'AlpacaApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}