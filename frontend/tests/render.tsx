import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { App } from '../src/app/App';

export function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}
