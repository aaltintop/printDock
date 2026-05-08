G4 (encrypted PDF) cannot be produced by pdf-lib.
Generate manually with qpdf if available, e.g.:
  qpdf --encrypt user owner 256 -- G2_a4_1page.pdf G4_encrypted.pdf
Then re-run the upload flow — extractMetadata() opens it with
{ ignoreEncryption: true } and should still report pageCount=1.