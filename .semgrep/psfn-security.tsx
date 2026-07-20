declare const untrustedHtml: string;

// ruleid: psfn.security.react-raw-html
const unsafeMarkup = <section dangerouslySetInnerHTML={{ __html: untrustedHtml }} />;

// ok: psfn.security.react-raw-html
const escapedMarkup = <section>{untrustedHtml}</section>;

void unsafeMarkup;
void escapedMarkup;
