// Los temporizadores de una pestaña oculta se frenan hasta uno por minuto; los de un worker no.
self.onmessage = e => setTimeout(() => self.postMessage(e.data.id), e.data.ms);
