import EmployeeProfile from '../components/EmployeeProfile.jsx'

export default function MyProfilePage({ session, onToast }) {
  return <EmployeeProfile self session={session} onToast={onToast} />
}
