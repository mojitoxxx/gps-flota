package es.gpsflota.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Las descargas (por ejemplo, la APK con una versión nueva de la app) se abren
        // en el navegador del móvil, que la descarga y permite instalarla.
        getBridge().getWebView().setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignorada) {
                // sin navegador disponible: no se hace nada
            }
        });
    }
}
