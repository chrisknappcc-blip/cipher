// ─── HubSpot Workflow Custom Code Action ───────────────────────────────────
// Workflow name suggestion: "Primary Outreach Rep — Email Activity"
//
// RULE THIS IMPLEMENTS: primary_outreach_rep always reflects whoever sent
// the most recent qualifying activity (email or meeting) — recalculated
// fresh every time, not a permanent handoff. Defaults to assigned_bdr
// naturally, since before any VP activity happens, the BDR is the only
// one triggering this workflow at all.
//
// SETUP IN HUBSPOT'S WORKFLOW EDITOR:
//
// 1. Automation > Workflows > Create workflow > Contact-based.
// 2. Trigger: "Email activity created" (or whichever trigger your existing
//    cipher_sequence_* tracking workflows already use for sent emails —
//    same event type works here).
// 3. Add a "Custom code" action, language: Node.js.
// 4. Add a Secret to this action (button near the code editor):
//      Name it exactly:  PRIVATE_APP_TOKEN
//      Value: your existing HubSpot Private App access token — the same
//      one already used for the sequence-tracking webhook, if you have it
//      handy. If not, Settings > Integrations > Private Apps > (your app)
//      > Auth tab has it.
// 5. Add an INPUT FIELD to this action:
//      Variable name: activityCreatedBy
//      Value: click the token icon and search for "Activity created by" —
//      select that property as the source.
// 6. Paste the code below into the code editor.
// 7. Test with a real contact before turning the workflow on — HubSpot's
//    test button runs this for real against whatever test record you
//    pick, so use one you don't mind actually being updated.

const hubspot = require("@hubspot/api-client");

exports.main = async (event, callback) => {
  const contactId = event["object"]["objectId"];
  const activityCreatedBy = event["inputFields"]["activityCreatedBy"];

  if (!activityCreatedBy) {
    // No creator name came through on this event — don't overwrite the
    // field with a blank value. Fails safe rather than silently clearing
    // an already-correct value.
    callback({ outputFields: { updated: false, reason: "no activityCreatedBy value" } });
    return;
  }

  const hubspotClient = new hubspot.Client({ accessToken: process.env.PRIVATE_APP_TOKEN });

  try {
    await hubspotClient.crm.contacts.basicApi.update(contactId, {
      properties: { primary_outreach_rep: activityCreatedBy },
    });
    callback({ outputFields: { updated: true, setTo: activityCreatedBy } });
  } catch (err) {
    console.error(err);
    callback({ outputFields: { updated: false, error: err.message } });
  }
};
