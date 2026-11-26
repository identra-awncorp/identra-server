import * as argon2 from 'argon2';

// The school portal's own records (docs/vc-api.md §5). Fictional people, public on purpose:
// every value says or implies DEMO; none of this is a real person.
export const DEMO_ISSUER = 'truong-mau';
/**
 * The sample school on the DID trust path (ADR-0020), provisioned only when DPKI is configured. Its
 * accounts are DEMO_DID_ACCOUNTS under `cn-` names (usernames are unique across issuers): cn-sv001,
 * cn-sv002, cn-sv003 (students), cn-phongdaotao (registrar).
 */
export const DEMO_DID_ISSUER = 'truong-mau-certnet';
export const DID_ACCOUNT_PREFIX = 'cn-';

/** The university's record of a graduate: the source of the seven diploma claims. */
export interface StudentProfile {
  hoTen: string;
  ngaySinh: string;
  maSinhVien: string;
  nganh: string;
  hangTotNghiep: string;
  namTotNghiep: string;
  soHieuBang: string;
}

export interface RegistrarProfile {
  hoTen: string;
  donVi: string;
}

export const DEMO_ACCOUNTS: Array<
  | { username: string; role: 'student'; profile: StudentProfile }
  | { username: string; role: 'registrar'; profile: RegistrarProfile }
> = [
  {
    username: 'sv001',
    role: 'student',
    profile: {
      hoTen: 'Nguyễn Thị Minh Anh',
      ngaySinh: '2003-04-17',
      maSinhVien: 'DEMO21CNTT0042',
      nganh: 'Công nghệ thông tin',
      hangTotNghiep: 'Giỏi',
      namTotNghiep: '2025',
      soHieuBang: 'TMDEMO-2025-000317'
    }
  },
  {
    username: 'sv002',
    role: 'student',
    profile: {
      hoTen: 'Trần Quốc Bảo',
      ngaySinh: '2002-11-03',
      maSinhVien: 'DEMO20DTVT0118',
      nganh: 'Kỹ thuật điện tử - viễn thông',
      hangTotNghiep: 'Khá',
      namTotNghiep: '2024',
      soHieuBang: 'TMDEMO-2024-001254'
    }
  },
  {
    username: 'sv003',
    role: 'student',
    profile: {
      hoTen: 'Lê Hoàng Phương Thảo',
      ngaySinh: '2004-01-29',
      maSinhVien: 'DEMO22QTKD0007',
      nganh: 'Quản trị kinh doanh',
      hangTotNghiep: 'Xuất sắc',
      namTotNghiep: '2026',
      soHieuBang: 'TMDEMO-2026-000029'
    }
  },
  {
    username: 'phongdaotao',
    role: 'registrar',
    profile: { hoTen: 'Phạm Văn Đức', donVi: 'Phòng Đào tạo, Trường Mẫu (DEMO)' }
  }
];

/**
 * The second school's own records (usernames get the `cn-` prefix): other fictional people with
 * their own birth dates and student codes, diplomas of its own series (`CNDEMO-` where the first
 * school's is `TMDEMO-`), and its own registrar.
 */
export const DEMO_DID_ACCOUNTS: typeof DEMO_ACCOUNTS = [
  {
    username: 'sv001',
    role: 'student',
    profile: {
      hoTen: 'Võ Ngọc Khánh Linh',
      ngaySinh: '2003-08-21',
      maSinhVien: 'DEMO21CNTT0187',
      nganh: 'Công nghệ thông tin',
      hangTotNghiep: 'Giỏi',
      namTotNghiep: '2025',
      soHieuBang: 'CNDEMO-2025-000317'
    }
  },
  {
    username: 'sv002',
    role: 'student',
    profile: {
      hoTen: 'Đặng Minh Khôi',
      ngaySinh: '2002-06-14',
      maSinhVien: 'DEMO20DTVT0233',
      nganh: 'Kỹ thuật điện tử - viễn thông',
      hangTotNghiep: 'Khá',
      namTotNghiep: '2024',
      soHieuBang: 'CNDEMO-2024-001254'
    }
  },
  {
    username: 'sv003',
    role: 'student',
    profile: {
      hoTen: 'Bùi Thanh Hà My',
      ngaySinh: '2004-03-05',
      maSinhVien: 'DEMO22QTKD0091',
      nganh: 'Quản trị kinh doanh',
      hangTotNghiep: 'Xuất sắc',
      namTotNghiep: '2026',
      soHieuBang: 'CNDEMO-2026-000029'
    }
  },
  {
    username: 'phongdaotao',
    role: 'registrar',
    profile: { hoTen: 'Ngô Thị Thu Hằng', donVi: 'Phòng Đào tạo, Trường Mẫu CertNet (DEMO)' }
  }
];

// Same parameters as user passwords (AuthService.hashPassword).
export const PORTAL_PASSWORD_HASH = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1
} as const;
