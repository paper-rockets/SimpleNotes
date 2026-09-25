package io.github.paperrockets.simplenotes;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final Uri NOTES_URL = Uri.parse("https://paper-rockets.github.io/SimpleNotes/");

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        boolean record = getIntent().getBooleanExtra("record", false);
        Uri target = record ? NOTES_URL.buildUpon().appendQueryParameter("record", "1").build() : NOTES_URL;
        Intent browser = new Intent(Intent.ACTION_VIEW, target);
        browser.addCategory(Intent.CATEGORY_BROWSABLE);
        browser.setPackage("com.android.chrome");
        Bundle customTab = new Bundle();
        customTab.putBinder("android.support.customtabs.extra.SESSION", null);
        browser.putExtras(customTab);
        browser.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", 0xFFEAE5D9);
        try {
            startActivity(browser);
        } catch (ActivityNotFoundException error) {
            browser.setPackage(null);
            try { startActivity(browser); }
            catch (ActivityNotFoundException missing) {
                Toast.makeText(this, "Install a browser to open SimpleNotes", Toast.LENGTH_LONG).show();
            }
        }
        finish();
    }
}
