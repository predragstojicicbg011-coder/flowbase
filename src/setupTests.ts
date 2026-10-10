// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// jsdom u jest-u 27 ne nudi TextEncoder/TextDecoder, a trebaju ih
// react-router@7 i nas importHash.ts. Uzimamo Node-ovu implementaciju.
import { TextEncoder, TextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  (global as any).TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  (global as any).TextDecoder = TextDecoder;
}

// Testovi nikad ne zovu pravu bazu, a src/supabase.ts pravi klijenta cim se
// ucita. Bez .env (svez klon FlowBase-a, CI) createClient bi pukao, a sa
// .env-om klijenta testovi bi drzali adresu njegove baze. Zato uvek lazna,
// lokalna adresa.
process.env.REACT_APP_SUPABASE_URL = 'http://localhost:54321';
process.env.REACT_APP_SUPABASE_ANON_KEY = 'test-anon-key';

// Isto i za ime klijenta: Jest ucitava .env, pa bi testovi u repou klijenta
// videli njegovo ime umesto FlowBase podrazumevanih vrednosti na koje
// racunaju. Testovi uvek rade na podrazumevanim vrednostima.
delete process.env.REACT_APP_APP_NAME;
delete process.env.REACT_APP_COMPANY_NAME;
delete process.env.REACT_APP_COMPANY_SHORT;
delete process.env.REACT_APP_TAGLINE;
