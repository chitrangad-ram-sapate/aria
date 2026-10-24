package app.aria.planner;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // A file shared to the app (ACTION_SEND) arrives as EXTRA_STREAM. Turn it into a VIEW intent
    // so @capacitor/app reports it through appUrlOpen / getLaunchUrl like "open with".
    private static Intent asView(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream != null) {
                intent.setAction(Intent.ACTION_VIEW);
                intent.setData(stream);
            }
        }
        return intent;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        asView(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(asView(intent));
    }
}
