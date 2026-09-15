// ─── HubSpot Workflow Custom Code Action ───────────────────────────────────
// Workflow name suggestion: "Primary Outreach Rep — Meeting Logged"
//
// Same rule, same code pattern as the email-trigger workflow — this one
// just fires on a different event: a meeting being logged with the
// contact. Whoever is shown as having created/logged that meeting becomes
// the new primary_outreach_rep, same as an email would.
//
// SETUP IN HUBSPOT'S WORKFLOW EDITOR:
//
// 1. Create a second, separate workflow, contact-based.
// 2. Trigger: "Meeting activity created" (or "Meeting outcome is any of
//    Completed, Scheduled..." — whichever meeting-related trigger your
//    portal already uses elsewhere; the exact trigger name can vary
//    slightly by HubSpot subscription tier).
// 3. Add a "Custom code" action, Node.js.
// 4. Reuse the SAME secret you already added for the email-trigger
//    workflow — secrets are shared across workflows once added, no need
//    to re-enter the token: name it PRIVATE_APP_TOKEN again to match.
// 5. Add an input field:
//      Variable name: activityCreatedBy
//      Value: search the token picker for a "created by" style token on
//      the meeting activity — the exact label may read slightly
//      differently than the email one ("Meeting created by," "Activity
//      created by," or similar depending on your portal). Pick whichever
//      one represents who logged/organized the meeting.
// 6. Paste the identical code below.
// 7. Test on a real record before activating, same as the other workflow.

const hubspot = require("@hubspot/api-client");

exports.main = async (event, callback) => {
  const contactId = event["object"]["objectId"];
  const activityCreatedBy = event["inputFields"]["activityCreatedBy"];

  if (!activityCreatedBy) {
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
