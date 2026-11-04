import { parseRegisterPage, companyFromRows, registerSearchUrl } from '../../supabase/functions/lookup-pib/nbsRegister'

// The NBS account register (Jedinstveni registar računa), read by the
// lookup-pib function: one row per account, the company repeated on each.
// The page below has the register's markup with a made-up company.

const row = (o: { name: string; address: string; bank: string; account: string; status: string; opened: string }) => `
  <tr>
    <td data-title="Назив корисника рачуна"><div><a href="/x"><b>${o.name}</b></a></div></td>
    <td data-title="Матични број"><div><b> <a href="/y">12345678</a></b></div></td>
    <td data-title="Порески број">100000001    </td>
    <td data-title="Адреса">${o.address}</td>
    <td data-title="Место">NOVI SAD</td>
    <td data-title="Општина">Novi Sad-grad</td>
    <td data-title="Делатност">Trgovina na veliko</td>
    <td data-title="Банка">${o.bank}</td>
    <td></td>
    <td data-title="Рачун"><div><b>${o.account}</b></div></td>
    <td></td>
    <td data-title="Статус"><div style="color:darkgreen"><b> ${o.status}</b></div></td>
    <td data-title="Подлеже/не подлеже блокади"><div> Подлеже блокади </div></td>
    <td data-title="Датум отварања"><div> ${o.opened} </div></td>
  </tr>`

const page = (rows: string[], total: number) => `<html><body><main>
  <table><thead><tr><th>Назив корисника рачуна</th></tr></thead><tbody>${rows.join('')}</tbody></table>
  <div>Укупан број резултата: ${total}</div></main></body></html>`

const OLD = { name: 'PRIMER DOO ZA TRGOVINU NOVI SAD', address: 'BULEVAR 1', bank: 'OTP Banka Srbija a.d. Novi Sad', account: '325-9500600000001-11', status: 'Укључен', opened: '29.7.2003.' }
const NEW = { name: 'PRIMER DOO NOVI SAD', address: 'BULEVAR OSLOBOĐENJA 1', bank: 'Banca Intesa A.D.- Beograd', account: '160-0000000000002-22', status: 'Укључен', opened: '3.2.2026.' }
const SHUT = { name: 'PRIMER DOO NOVI SAD', address: 'BULEVAR 1', bank: 'Addiko Bank AD Beograd', account: '165-0000000000003-33', status: 'Угашен', opened: '1.1.2010.' }

describe('a page of the NBS account register', () => {
  it('reads each account row and the total', () => {
    const r = parseRegisterPage(page([row(OLD), row(NEW)], 2))
    expect(r.total).toBe(2)
    expect(r.rows[0]).toEqual({
      name: 'PRIMER DOO ZA TRGOVINU NOVI SAD', mb: '12345678', pib: '100000001', address: 'BULEVAR 1', city: 'NOVI SAD',
      municipality: 'Novi Sad-grad', activity: 'Trgovina na veliko', bankName: 'OTP Banka Srbija a.d. Novi Sad',
      account: '325-9500600000001-11', status: 'Укључен', blockable: 'Подлеже блокади', opened: '2003-07-29',
    })
  })

  it('reads the column names the register writes as character references', () => {
    const encoded = page([row(OLD)], 1).replace(/data-title="([^"]*)"/g, (_m, t: string) =>
      `data-title="${[...t].map(c => (c.charCodeAt(0) > 127 ? `&#x${c.charCodeAt(0).toString(16).toUpperCase()};` : c)).join('')}"`)
    expect(encoded).toContain('&#x41C;')
    expect(parseRegisterPage(encoded).rows[0]).toMatchObject({ mb: '12345678', account: '325-9500600000001-11', opened: '2003-07-29' })
  })

  it('a page with no results gives none', () => {
    expect(parseRegisterPage('<html><main>Нема резултата</main></html>')).toEqual({ rows: [], total: 0 })
  })
})

describe('the company the rows describe', () => {
  it('is named as on its newest account, with every open account and its bank', () => {
    const c = companyFromRows(parseRegisterPage(page([row(OLD), row(NEW), row(SHUT)], 3)).rows)
    expect(c).toMatchObject({ name: 'PRIMER DOO NOVI SAD', mb: '12345678', pib: '100000001', address: 'BULEVAR OSLOBOĐENJA 1', city: 'NOVI SAD' })
    expect(c?.accounts).toEqual([
      { account: '160-0000000000002-22', bankName: 'Banca Intesa A.D.- Beograd', opened: '2026-02-03' },
      { account: '325-9500600000001-11', bankName: 'OTP Banka Srbija a.d. Novi Sad', opened: '2003-07-29' },
    ])
  })

  it('no rows is no company', () => {
    expect(companyFromRows([])).toBeNull()
  })
})

describe('the search address', () => {
  it('asks for the dinar accounts of one registration number, a page at a time', () => {
    const u = new URL(registerSearchUrl('12345678', 2))
    expect(u.origin + u.pathname).toBe('https://webappcenter.nbs.rs/PnWebApp/CompanyAccount/CompanyAccountResident')
    expect(u.searchParams.get('CompanyNationalCode')).toBe('12345678')
    expect(u.searchParams.get('isSearchExecuted')).toBe('true')
    expect(u.searchParams.get('TypeID')).toBe('1')
    expect(u.searchParams.get('Pagging.CurrentPage')).toBe('2')
  })
})
